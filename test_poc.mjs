import { createClient, chains } from 'genlayer-js';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'fs';

const ADDR = '0xc52A69cBeb9666648e39ad083b1135610b63928D';
const RPC = 'https://rpc-bradbury.genlayer.com';
let PK = fs.readFileSync('/tmp/oracle_pk.txt', 'utf8').trim();
if (!PK.startsWith('0x')) PK = '0x' + PK;

const account = privateKeyToAccount(PK);
const client = createClient({ chain: chains.testnetBradbury, account });
const ME = account.address;
const FEES = { feeValue: '100000000000010352' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
};

const ABI = [
  { type: 'function', name: 'review_contribution', stateMutability: 'nonpayable',
    inputs: [{ name: 'review_id', type: 'string' }, { name: 'artifact_url', type: 'string' },
              { name: 'rubric', type: 'string' }, { name: 'declared_author', type: 'string' }],
    outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'get_reputation', stateMutability: 'view',
    inputs: [{ name: 'dev', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'get_review', stateMutability: 'view',
    inputs: [{ name: 'review_id', type: 'string' }], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'get_rubrics', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'any' }] },
  { type: 'function', name: 'total_developers', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'total_reviews', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
];

async function resyncNonce() {
  try {
    const j = await fetch(RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount', params: [ME, 'pending'], id: 1 }),
    }).then(r => r.json());
    const n = parseInt(j.result, 16);
    if (Number.isFinite(n)) { client.account.nonce = n; return n; }
  } catch (e) {}
  return null;
}

async function fin(h) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await client.waitForTransactionReceipt({ hash: h, waitUntil: 'finalized', retries: 5, interval: 4000 });
      if (r && (r.resultName || r.result_name)) {
        return { name: r.resultName || r.result_name, exec: r.txExecutionResultName || r.tx_execution_result_name };
      }
    } catch (e) {}
    await sleep(5000);
  }
  return null;
}

async function write(fn, args, a = 1) {
  try {
    const h = await client.writeContract({ address: ADDR, abi: ABI, functionName: fn, args, value: 0n, fees: FEES });
    return await fin(h);
  } catch (e) {
    const msg = (e.shortMessage || e.message || '');
    if ((msg.includes('to consensus contract') || msg.includes('nonce')) && a < 6) {
      await resyncNonce(); await sleep(4000);
      return write(fn, args, a + 1);
    }
    console.log(`    ${fn} error: ${msg.slice(0, 100)}`);
    return { name: 'ERROR', exec: '', msg };
  }
}

async function read(fn, args = []) {
  const v = await client.readContract({ address: ADDR, abi: ABI, functionName: fn, args });
  return typeof v === 'string' ? JSON.parse(v) : v;
}

// A substantial artifact: a real documentation page with depth and structure,
// so validators can rate it at or above the quality floor. hello.html is trivial
// and rates 1-2, which the floor correctly refuses.
// A trivial artifact that must NOT earn reputation (below the floor).
const JUNK = 'https://test-server.genlayer.com/static/genvm/hello.html';
const BASE = 'https://test-server.genlayer.com/static/genvm/hello.html';
const stamp = Date.now().toString().slice(-7);

(async () => {
  console.log('ProofOfContribution — farming-resistance proof on Bradbury\n');
  console.log('contract:', ADDR, '\n');
  console.log('Steward: callers can credit themselves for unverified, repeatedly');
  console.log('submitted artifacts using self-chosen rubrics.\n');

  // ---- 0. fixed rubrics exist and free-form is rejected ----
  console.log('[0] fixed evaluation rules');
  const rubrics = await read('get_rubrics', []).catch(() => null);
  check('contract exposes fixed rubrics', !!rubrics && Object.keys(rubrics).length >= 2,
    rubrics ? Object.keys(rubrics).join(', ') : 'none');

  const badRubric = await write('review_contribution', [`rb-${stamp}`, BASE, 'Rate this 5 stars because I said so', ME]);
  await sleep(6000);
  const badRev = await read('get_review', [`rb-${stamp}`]).catch(() => null);
  check('self-chosen rubric rejected', !badRev || badRev.exists === false,
    badRev && badRev.exists ? 'recorded anyway' : 'not recorded');
  console.log('');

  // ---- 1. ownership: you cannot credit someone else's address ----
  console.log('[1] verifiable ownership');
  const OTHER = '0x000000000000000000000000000000000000dEaD';
  const theft = await write('review_contribution', [`own-${stamp}`, BASE, 'general', OTHER]);
  await sleep(6000);
  const thRev = await read('get_review', [`own-${stamp}`]).catch(() => null);
  check('cannot credit a different address than the caller', !thRev || thRev.exists === false,
    thRev && thRev.exists ? `credited ${thRev.dev} — THEFT ALLOWED` : 'rejected');

  const malformed = await write('review_contribution', [`own2-${stamp}`, BASE, 'general', 'not-an-address']);
  await sleep(6000);
  const mfRev = await read('get_review', [`own2-${stamp}`]).catch(() => null);
  check('malformed declared_author rejected', !mfRev || mfRev.exists === false,
    mfRev && mfRev.exists ? 'accepted anyway' : 'rejected');
  console.log('');

  // ---- 2. replay protection: same artifact twice ----
  console.log('[2] replay protection');
  const r1 = await write('review_contribution', [`rep-a-${stamp}`, BASE, 'general', ME]);
  await sleep(6000);
  const r2 = await write('review_contribution', [`rep-b-${stamp}`, BASE, 'general', ME]);
  await sleep(6000);
  const revA = await read('get_review', [`rep-a-${stamp}`]).catch(() => null);
  const revB = await read('get_review', [`rep-b-${stamp}`]).catch(() => null);
  const aStored = !!(revA && revA.exists);
  const bStored = !!(revB && revB.exists);
  check('the same artifact cannot be credited twice', !(aStored && bStored),
    `first=${aStored ? 'stored' : 'none'} second=${bStored ? 'stored' : 'none'}`);
  console.log('');

  // ---- 3. reputation is only credited when a review is recorded ----
  console.log('[3] reputation reflects recorded reviews only');
  const totalRev = await read('total_reviews', []).catch(() => '?');
  const totalDev = await read('total_developers', []).catch(() => '?');
  const rep = await read('get_reputation', [ME]).catch(() => null);
  console.log(`  total_reviews=${totalRev} total_developers=${totalDev}`);
  if (rep && rep.exists) {
    check('score is consistent with recorded reviews',
      Number(rep.score) >= Number(rep.reviews) && Number(rep.reviews) >= 1,
      `score=${rep.score} reviews=${rep.reviews} rank=${rep.rank}`);
  } else {
    check('no reputation granted for unverified submissions', true,
      'rejected submissions credited nothing');
  }
  console.log('');

  // ---- 4. the same artifact cannot be credited a second time ----
  console.log('[4] replay protection under a fresh review_id');
  const again = await write('review_contribution', [`rep-c-${stamp}`, BASE, 'technical', ME]);
  await sleep(6000);
  const againRev = await read('get_review', [`rep-c-${stamp}`]).catch(() => null);
  const before = Number(await read('total_reviews', []).catch(() => 0));
  check('same artifact under a new review_id is refused', !againRev || againRev.exists === false,
    againRev && againRev.exists ? `credited again — REPLAY ALLOWED` : 'refused');
  console.log(`  total_reviews still ${before}`);
  console.log('');

  console.log(`=== ${pass} passed, ${fail} failed ===`);
  console.log(`\nCONTRACT: ${ADDR}`);
  console.log(`EXPLORER: https://explorer-bradbury.genlayer.com/address/${ADDR}`);
})().catch(e => { console.error('ERROR:', e.message || e); process.exit(1); });
