## a-chaos-seed5-read-only

    npm run --silent cli -- --runs-dir runs-live/ev/retry replay artifacts/lookup-member-savings-balance.json --input memberId=12345 --operator-port 0 --read-only --fault {"chaos":{"seed":5,"failSearch":0.2}}

## b-failsearch-read-only

    npm run --silent cli -- --runs-dir runs-live/ev/retry replay artifacts/lookup-member-savings-balance.json --input memberId=12345 --operator-port 0 --read-only --fault {"failSearch":true}

## c1-seed42-times6

    npm run --silent cli -- --runs-dir runs-live/ev/retry replay artifacts/lookup-member-savings-balance.json --input memberId=12345 --operator-port 0 --times 6 --auto-operator relogin --fault {"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5,"expireSession":0.15}}

## c2-seed42-times6-read-only

    npm run --silent cli -- --runs-dir runs-live/ev/retry replay artifacts/lookup-member-savings-balance.json --input memberId=12345 --operator-port 0 --times 6 --auto-operator relogin --read-only --fault {"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5,"expireSession":0.15}}

