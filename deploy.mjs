// Deploy ConstitutionGate to GenLayer Bradbury (chain 4221) via genlayer-js.
// Code is passed as a UTF-8 string (Uint8Array makes gas estimation revert on
// Bradbury); receipts are polled with waitUntil:'finalized' and the address is
// read from receipt.txDataDecoded.contractAddress. Deploy is retried because a
// deploy can transiently return AGREE while storing no contract code.
import { createClient, createAccount } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import fs from 'fs';

const PK = process.env.DEPLOY_PK;
if (!PK) { console.error('DEPLOY_PK not set'); process.exit(1); }

const CONTRACT = '/home/administrator/proof-of-contribution/contracts/proof_of_contribution.py';

async function main() {
  const account = createAccount(PK);
  const client = createClient({ chain: testnetBradbury, account });
  const code = fs.readFileSync(CONTRACT, 'utf8');
  console.log('Contract bytes:', code.length);

  for (let t = 1; t <= 3; t++) {
    const tx = await client.deployContract({ code });
    const receipt = await client.waitForTransactionReceipt({
      hash: tx, waitUntil: 'finalized', retries: 250, interval: 4000,
    });
    const addr = receipt?.txDataDecoded?.contractAddress;
    console.log(`attempt ${t}: result=${receipt?.resultName} exec=${receipt?.txExecutionResultName}`);
    if (!addr) continue;
    await new Promise(x => setTimeout(x, 8000));
    let stored = '';
    try { stored = (await client.getContractCode(addr)) || ''; } catch (e) { /* */ }
    console.log(`  addr=${addr} code stored ${stored.length} bytes`);
    if (stored.length > 0) {
      fs.writeFileSync('/home/administrator/proof-of-contribution/addr.txt', addr);
      console.log('DEPLOYED:', addr);
      return;
    }
  }
  console.error('FAIL: deploy stored no contract code after retries');
  process.exit(1);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
