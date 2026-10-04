# Gather — backend (`@gather/core` + native TurboModules)

Gather has **no server**. Phones in the same place sync directly over OpenHarmony's distributed soft bus and `distributedKVStore`. Here, "backend" means the logic layer that runs on every phone:

```
React Native screens (TS)
        │  Gather API (src/gather.ts)
        ▼
@gather/core  ── split.ts      bill splitting (claims, shared items, tax/tip, exact rounding)
              ── settle.ts     running balances + minimum number of payments
              ── receipt.ts    OCR lines -> items/tax/tip/total, flags misreads
              ── state.ts      op log -> state (deterministic, validated, permissioned)
              ── sync.ts       op log on a KV backend, HLC clock, version vectors
              ── voice.ts      offline voice commands (EN/PL)
              ── payments.ts   "You owe Anna €18.40", PayPal/SEPA-QR links, reminders
              ── invite.ts     QR invite payload
        │  KVBackend
        ▼
harmony/gather_modules (ArkTS TurboModules)
              ── SyncStore   -> @kit.ArkData distributedKVStore (autoSync, encrypted, S1)
              ── GatherNet   -> @kit.DistributedServiceKit distributedDeviceManager (discover, bind with confirmation)
              ── Reminders   -> @kit.BackgroundTasksKit reminderAgentManager
specs/        RN codegen specs for the above + ReceiptAI and Speech
```

## How sync works (and why it merges cleanly)

- Every change is an immutable **op** (`src/ops.ts`) stored under its own key: `g/<gatherId>/op/<deviceId>/<seq>`. A key is only ever written by one device, so the KV store never has write conflicts to resolve.
- Each op carries a **hybrid logical clock** timestamp. State is computed by replaying all ops in HLC order (`materialize`), so any phone with the same ops computes the same state, whatever order they arrived in. This is checked by a test that shuffles op order.
- Offline edits are just ops that sync later. Concurrent edits to the same field resolve as last-writer-wins by HLC. Claims are per (item, person), so two people tapping at the same time both count.
- Rules are enforced during replay. Invalid input, ops from a removed device, or a non-owner removing someone are skipped and listed in `state.rejected`; they never crash the Gather.
- `versionVector()` and `opsMissingFrom()` allow the same log to sync over a transport other than the KV store, for example a socket fallback if the soft bus is not available between emulators.

## Run it

Requirements: Node.js 20 or later (tested on 24.15).

```bash
cd One-Liner-Backend
npm install
npm test          # 33 tests: money, split, settle (vs brute force), receipt, voice, invite, payments, sync/merge
npm run typecheck
npm run demo      # hackathon demo script on two simulated phones (create/join, list, receipt, settle, offline merge)
```

## Using it from the RN app

```ts
import NativeSyncStore from '@gather/core/specs/NativeSyncStore';
import { DeviceEventEmitter } from 'react-native';
import { Gather, createSyncStoreBackend } from '@gather/core';

const backend = await createSyncStoreBackend(NativeSyncStore, (e, h) => DeviceEventEmitter.addListener(e, h));
const gather = await Gather.create(backend, { deviceId, name: 'Dinner', ownerName: 'Anna', currency: 'EUR' });
gather.onChange((state) => render(state));
await gather.addListItem('Sunscreen');
```

On the OpenHarmony side, add the `harmony/gather_modules` HAR to the RNOH project and register `new GatherPackage(ctx)` in `RNPackagesFactory`. Target **API 20** (`compatibleSdkVersion: "6.0.0(20)"` in `build-profile.json5`).

## Status / known gaps

- `@gather/core` is complete and tested in Node.
- The ArkTS modules are written against the API 20 docs (`@kit.ArkData`, `@kit.DistributedServiceKit`, `@kit.BackgroundTasksKit`) but **have not been compiled in DevEco Studio yet**. Build them and adjust before the demo.
- Not implemented natively yet: `ReceiptAI` (Core Vision Kit OCR + MindSpore Lite), `Speech` (Core Speech Kit), and photo file transfer. Specs and core-side logic exist: `parseReceipt`, `parseVoiceCommand`, `photo.add` / `missingPhotos`.
- Distributed sync between **two emulators** depends on soft bus support in the emulator image. Check this early. If it is not supported, use the version-vector API over a local socket.
