// ProofOfContribution relay backend.
//
// Why this exists: a GenLayer write is a rollup transaction that must be signed
// by a key the client holds. An injected browser wallet (MetaMask) cannot
// produce that signature, so a pure-frontend write path fails with "No account
// set". This backend holds the signer and sends the transaction on behalf of
// the submitted review, then reports the committed result.
//
// The signer key lives only here, as an environment variable — never in the
// frontend bundle.
import express from 'express';
import cors from 'cors';
import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';

const PK = process.env.DEPLOY_PK;
if (!PK) {
  console.error('DEPLOY_PK is not set — refusing to start without a signer.');
  process.exit(1);
}

const CONTRACT = process.env.CONTRACT_ADDRESS
  || '0x218E6256B0ED02F0Bb5155E5Ae93219168c4c32f';
const PORT = process.env.PORT || 3000;
const FEES = { feeValue: '100000000000010352' };

const account = createAccount(PK.startsWith('0x') ? PK : '0x' + PK);
const client = createClient({ chain: testnetBradbury, account });
const reader = createClient({ chain: testnetBradbury });

const ABI = [
  { type: 'function', name: 'review_contribution', stateMutability: 'nonpayable',
    inputs: [{ name: 'review_id', type: 'string' }, { name: 'artifact_url', type: 'string' },
              { name: 'rubric', type: 'string' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'get_reputation', stateMutability: 'view',
    inputs: [{ name: 'dev', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'get_review', stateMutability: 'view',
    inputs: [{ name: 'review_id', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'total_developers', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'total_reviews', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));

const URL_RE = /^https?:\/\/[^\s]+$/i;
// Review ids are caller-supplied labels; keep them bounded and free of
// characters that would break the JSON payload.
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

async function fin(hash) {
  for (let i = 0; i < 250; i++) {
    try {
      const r = await client.waitForTransactionReceipt({
        hash, waitUntil: 'finalized', retries: 250,
      });
      if (r && r.resultName) return r;
    } catch (e) { /* transient */ }
    await new Promise(x => setTimeout(x, 4000));
  }
  return null;
}

function parse(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

app.get('/api/health', async (req, res) => {
  let codeBytes = 0;
  try { codeBytes = ((await client.getContractCode(CONTRACT)) || '').length; } catch (e) { /* */ }
  res.json({ ok: true, contract: CONTRACT, codeBytes, signer: account.address });
});

app.get('/api/stats', async (req, res) => {
  try {
    const d = await reader.readContract({ address: CONTRACT, abi: ABI, functionName: 'total_developers', args: [] });
    const r = await reader.readContract({ address: CONTRACT, abi: ABI, functionName: 'total_reviews', args: [] });
    res.json({ developers: String(d), reviews: String(r) });
  } catch (e) {
    res.status(502).json({ error: 'could not read contract state' });
  }
});

app.get('/api/reputation/:addr', async (req, res) => {
  try {
    const v = await reader.readContract({ address: CONTRACT, abi: ABI, functionName: 'get_reputation', args: [req.params.addr] });
    res.json(parse(v));
  } catch (e) {
    res.status(502).json({ error: 'could not read reputation' });
  }
});

async function resyncNonce() {
  // The SDK caches the nonce; a transient revert advances the chain's nonce past
  // it and every later write then reverts at the consensus contract. Read the
  // pending nonce straight from the chain and force the client to use it.
  try {
    const res = await fetch('https://rpc-bradbury.genlayer.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount',
                             params: [account.address, 'pending'], id: 1 }),
    });
    const j = await res.json();
    const n = parseInt(j.result, 16);
    if (Number.isFinite(n)) { client.account.nonce = n; return n; }
  } catch (e) { /* leave the cached nonce in place */ }
  return null;
}

async function sendReview(args) {
  // A revert to the consensus contract is recoverable nonce desync, not a
  // contract failure — resync and retry rather than surfacing an error.
  for (let a = 1; a <= 5; a++) {
    try {
      return await client.writeContract({
        address: CONTRACT, abi: ABI, functionName: 'review_contribution',
        args, value: 0n, fees: FEES, gasLimit: 5000000n,
      });
    } catch (e) {
      const msg = (e.shortMessage || e.message || '');
      const recoverable = msg.includes('to consensus contract')
        || msg.includes('nonce is not consistent')
        || msg.includes('nonce too low');
      if (recoverable && a < 5) {
        const n = await resyncNonce();
        console.log(`nonce resync -> ${n} (attempt ${a})`);
        await new Promise(x => setTimeout(x, 4000));
        continue;
      }
      throw e;
    }
  }
}

app.post('/api/review', async (req, res) => {
  const { review_id, artifact_url, rubric } = req.body || {};
  if (!review_id || !artifact_url || !rubric) {
    return res.status(400).json({ error: 'review_id, artifact_url and rubric are required' });
  }
  if (!ID_RE.test(review_id)) {
    return res.status(400).json({ error: 'review_id must be 1-64 chars: letters, digits, dot, underscore, hyphen' });
  }
  if (!URL_RE.test(artifact_url)) {
    return res.status(400).json({ error: 'artifact_url must be an http(s) URL' });
  }
  if (rubric.length > 500) {
    return res.status(400).json({ error: 'rubric must be 500 characters or fewer' });
  }

  try {
    const hash = await sendReview([review_id, artifact_url, rubric]);
    const receipt = await fin(hash);
    const resultName = receipt && receipt.resultName;
    const exec = receipt && receipt.txExecutionResultName;

    // read back the committed review — the receipt alone is not proof
    let review = null;
    for (let i = 0; i < 12; i++) {
      try {
        const v = await reader.readContract({ address: CONTRACT, abi: ABI, functionName: 'get_review', args: [review_id] });
        const o = parse(v);
        if (o && o.exists) { review = o; break; }
      } catch (e) { /* read-path lag */ }
      await new Promise(x => setTimeout(x, 5000));
    }

    res.json({
      tx: hash,
      resultName,
      exec,
      review,
      committed: !!(review && review.exists),
    });
  } catch (e) {
    const msg = (e.shortMessage || e.message || 'transaction failed').slice(0, 200);
    res.status(502).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`ProofOfContribution relay listening on :${PORT}`);
  console.log(`contract: ${CONTRACT}`);
  console.log(`signer:   ${account.address}`);
});
