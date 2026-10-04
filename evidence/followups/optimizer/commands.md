## 1-validate-shipped

    npm run --silent cli -- validate artifacts/lookup-member-savings-balance.json

## 2-optimize-not-declared-read-only

    npm run --silent cli -- --runs-dir runs-live/ev/optimizer optimize artifacts/lookup-member-savings-balance.json --input memberId=12345 --out evidence/followups/optimizer/should-not-exist.json

## 3-optimize-read-only

    npm run --silent cli -- --runs-dir runs-live/ev/optimizer optimize artifacts/lookup-member-savings-balance.json --input memberId=12345 --read-only --out evidence/followups/optimizer/lookup-member-savings-balance.optimized.json

## 4-validate-optimized

    npm run --silent cli -- validate evidence/followups/optimizer/lookup-member-savings-balance.optimized.json

## 5-replay-optimized-draft

    npm run --silent cli -- --runs-dir runs-live/ev/optimizer replay evidence/followups/optimizer/lookup-member-savings-balance.optimized.json --input memberId=10002 --operator-port 0

