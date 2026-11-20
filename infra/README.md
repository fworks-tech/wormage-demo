# Wormage infra (M3)

AWS CDK (TypeScript) app for the Wormage backend. Tracks issue #16 / milestone M3.

## Prerequisites

- Node 20+
- AWS credentials (`aws login` or env vars)
- `npm install` in this directory

## Commands

```bash
cd infra
npm install
npm run build        # tsc
npm run synth        # cdk synth
npm run diff         # cdk diff
npm run deploy       # cdk deploy
```

## Scope (sub-issues)

- #130 scaffold (this directory)
- #131 API Gateway HTTP API + Lambda (Node 20)
- #132 DynamoDB single-table + leaderboard GSI
- #133 custom domain `api.wormage.flabs.tech`
- #134 `live` API mode in `src/api/client.ts`
- #135 port leaderboard/matches endpoints, keep `clientMatchId` idempotency
- #136 CORS for `wormage.flabs.tech`
- #137 deploy workflow
