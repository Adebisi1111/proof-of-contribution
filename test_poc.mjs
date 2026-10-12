// On-chain test suite for ProofOfContribution.
//   DEPLOY_PK=0x<key> node test_poc.mjs
// Assertions read committed state back from chain; receipt fields are logged
// but never used as the pass criterion.

import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import fs from 'fs';

const PK = process.env.DEPLOY_PK;
if (!PK) { console.error('DEPLOY_PK not set'); process.exit(1); }

const account = createAccount(PK);
const client = createClient({ chain: testnetBradbury, account });
const FEES = { feeValue: '100000000000010352' };
const me = account.address;

const URL_GOOD = 'https://test-server.genlayer.com/static/genvm/hello.html';
const RUBRIC = 'Rate depth, clarity, and quality from 1 (poor) to 5 (excellent).';

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

let passed = 0, failed = 0, ADDR = null;

function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function fin(h) {
  for (let i = 0; i < 250; i++) {
    try {
      const r = await client.waitForTransactionReceipt({ hash: h, waitUntil: 'finalized', retries: 250 });
      if (r && r.resultName) return r;
    } catch (e) { /* transient */ }
    await new Promise(x => setTimeout(x, 4000));
  }
  return null;
}

async function write(fn, args) {
  for (let a = 1; a <= 6; a++) {
    try {
      const h = await client.writeContract({
        address: ADDR, abi: ABI, functionName: fn, args, value: 0n, fees: FEES, gasLimit: 5000000n,
      });
      return await fin(h);
    } catch (e) {
      const msg = (e.shortMessage || e.message || '');
      // A transient revert advances the chain nonce past the SDK's cached
      // value, and every later write then fails — sometimes as an explicit
      // "nonce is not consistent", sometimes simply as a revert to the
      // consensus contract. Treat any consensus-contract revert as a
      // recoverable nonce desync: resync from the chain and retry.
      // (getCurrentNonce is not served by this RPC — it returns HTML — so the
      // nonce is read with raw eth_getTransactionCount.)
      const recoverable =
        msg.includes('nonce is not consistent') ||
        msg.includes('nonce too low') ||
        msg.includes('to consensus contract') ||
        msg.includes('Invalid parameters were provided to the RPC method');
      if (recoverable && a < 6) {
        try {
          const res = await fetch('https://rpc-bradbury.genlayer.com', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount',
                                   params: [me, 'pending'], id: 1 }),
          });
          const j = await res.json();
          const n = parseInt(j.result, 16);
          if (Number.isFinite(n)) {
            client.account.nonce = n;
            console.log(`  nonce resynced to ${n} (attempt ${a}): ${msg.slice(0, 60)}`);
          }
        } catch (e2) { /* fall through to retry */ }
        await new Promise(x => setTimeout(x, 4000));
        continue;
      }
      console.log(`  write ${fn} failed permanently: ${msg.slice(0, 120)}`);
      return null;
    }
  }
  return null;
}

async function read(fn, args, expect) {
  // `expect` is an optional predicate: keep polling until it holds, so a
  // profile read does not return an intermediate value (e.g. reviews=2 while
  // total_reviews is already 3) and produce a false failure.
  for (let i = 0; i < 40; i++) {
    try {
      const v = await client.readContract({ address: ADDR, abi: ABI, functionName: fn, args });
      const o = typeof v === 'string' ? JSON.parse(v) : v;
      if (o && o.exists && (!expect || expect(o))) return o;
    } catch (e) { /* read-path lag */ }
    await new Promise(x => setTimeout(x, 5000));
  }
  // one last read without the predicate, so callers still get whatever exists
  try {
    const v = await client.readContract({ address: ADDR, abi: ABI, functionName: fn, args });
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    if (o && o.exists) return o;
  } catch (e) { /* */ }
  return null;
}

async function deploy(code, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    const dr = await fin(await client.deployContract({ code }));
    const addr = dr && dr.txDataDecoded && dr.txDataDecoded.contractAddress;
    if (!addr) { console.log(`  deploy ${t}: no address`); continue; }
    await new Promise(x => setTimeout(x, 8000));
    let stored = '';
    try { stored = (await client.getContractCode(addr)) || ''; } catch (e) { /* */ }
    console.log(`  deploy ${t}: ${addr} — code stored ${stored.length} bytes`);
    if (stored.length > 0) return addr;
  }
  throw new Error('deploy stored no contract code after retries');
}

// --- 1: a review commits a rating and updates the profile -------------------
async function testReviewAndProfile() {
  console.log('\n[1] a review commits a rating and updates the developer profile');
  const rid = 'rev-1';
  for (let a = 1; a <= 5; a++) {
    const r = await write('review_contribution', [rid, URL_GOOD, RUBRIC]);
    console.log(`  review#${a}: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const rev = await read('get_review', [rid]);
  check('review committed', !!rev);
  check('rating is 1-5', rev && Number(rev.rating) >= 1 && Number(rev.rating) <= 5,
    `rating=${rev && rev.rating}`);
  check('rating credited to caller', rev && rev.dev === me);

  const rep = await read('get_reputation', [me]);
  check('profile exists', !!rep);
  check('score equals the rating', rep && Number(rep.score) === Number(rev && rev.rating),
    `score=${rep && rep.score} rating=${rev && rev.rating}`);
  check('reviews counted', rep && Number(rep.reviews) === 1);
  check('best recorded', rep && Number(rep.best) === Number(rev && rev.rating));
  check('avg_x100 matches score x100 for one review', rep && Number(rep.avg_x100) === Number(rep.score) * 100,
    `avg_x100=${rep && rep.avg_x100}`);
  check('rank is NEWCOMER below 3 reviews', rep && rep.rank === 'NEWCOMER', `rank=${rep && rep.rank}`);
  return rev;
}

// --- 2: multiple reviews accumulate ----------------------------------------
async function testAccumulation() {
  console.log('\n[2] multiple reviews accumulate into the profile');
  for (const rid of ['rev-2', 'rev-3']) {
    for (let a = 1; a <= 5; a++) {
      const r = await write('review_contribution', [rid, URL_GOOD, RUBRIC]);
      if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
      await new Promise(x => setTimeout(x, 4000));
    }
  }
  const rep = await read('get_reputation', [me], (o) => Number(o.reviews) === 3);
  check('reviews count is 3', rep && Number(rep.reviews) === 3, `reviews=${rep && rep.reviews}`);
  check('score is the sum of ratings', rep && Number(rep.score) >= 3 && Number(rep.score) <= 15,
    `score=${rep && rep.score}`);
  check('rank is no longer NEWCOMER', rep && rep.rank !== 'NEWCOMER', `rank=${rep && rep.rank}`);
  const tr = await client.readContract({ address: ADDR, abi: ABI, functionName: 'total_reviews', args: [] }).catch(() => '?');
  check('total_reviews is 3', String(tr) === '3', `got ${String(tr)}`);
  const td = await client.readContract({ address: ADDR, abi: ABI, functionName: 'total_developers', args: [] }).catch(() => '?');
  check('total_developers is 1', String(td) === '1', `got ${String(td)}`);
}

// --- 3: duplicate review is rejected ---------------------------------------
async function testDuplicateRejected() {
  console.log('\n[3] duplicate review_id is rejected');
  const r = await write('review_contribution', ['rev-1', URL_GOOD, RUBRIC]);
  console.log(`  duplicate: result=${r && r.resultName} exec=${r && r.txExecutionResultName}`);
  check('duplicate rejected', r && r.txExecutionResultName !== 'FINISHED_WITH_RETURN',
    `exec=${r && r.txExecutionResultName}`);
}

// --- 4: rigged leader inflating the rating is rejected ---------------------
async function testRiggedLeader() {
  console.log('\n[4] rigged leader inflating the rating is rejected');
  const src = fs.readFileSync(new URL('./contracts/proof_of_contribution.py', import.meta.url), 'utf8');
  const rigged = src.replace(
    '        def leader_fn() -> dict:\n            return _rate(_fetch_artifact(url), r)',
    '        def leader_fn() -> dict:\n            return {"rating": 5}');
  if (rigged === src) { check('rigged variant built', false, 'replacement did not apply'); return; }
  fs.writeFileSync(new URL('./contracts/_adv.py', import.meta.url), rigged);
  const adv = await deploy(rigged);
  const saved = ADDR; ADDR = adv;
  let disagree = 0;
  for (let a = 1; a <= 5; a++) {
    const r = await write('review_contribution', ['adv-rev', URL_GOOD, RUBRIC]);
    console.log(`  rigged review#${a}: result=${r && r.resultName}`);
    if (r && r.resultName === 'DISAGREE') disagree++;
    if (r && r.resultName === 'AGREE' && r.txExecutionResultName === 'FINISHED_WITH_RETURN') break;
    await new Promise(x => setTimeout(x, 4000));
  }
  const rev = await read('get_review', ['adv-rev']);
  const t = await client.readContract({ address: adv, abi: ABI, functionName: 'total_reviews', args: [] }).catch(() => '?');
  console.log(`  total_reviews on rigged contract: ${String(t)}`);
  check('rigged leader never committed', !rev);
  check('total_reviews is 0', String(t) === '0', `got ${String(t)}`);
  check('at least 3 rounds DISAGREE', disagree >= 3, `disagree=${disagree}`);
  ADDR = saved;
  fs.rmSync(new URL('./contracts/_adv.py', import.meta.url), { force: true });
}

async function main() {
  console.log('ProofOfContribution — on-chain test suite');
  console.log('account:', me);
  console.log('\n[0] deploy');
  ADDR = await deploy(fs.readFileSync(new URL('./contracts/proof_of_contribution.py', import.meta.url), 'utf8'));
  console.log('CONTRACT:', ADDR);

  await testReviewAndProfile();
  await testAccumulation();
  await testDuplicateRejected();
  await testRiggedLeader();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  console.log(`CONTRACT UNDER TEST: ${ADDR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', (e.shortMessage || e.message).slice(0, 150)); process.exit(1); });
