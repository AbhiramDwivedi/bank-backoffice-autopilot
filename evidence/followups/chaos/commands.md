## replay-times-6-seed-42

    npm run --silent cli -- --runs-dir runs-live/ev/chaos replay artifacts/lookup-member-savings-balance.json --input memberId=12345 --times 6 --auto-operator relogin --operator-port 0 --fault {"chaos":{"seed":42,"failSearch":0.2,"interstitial":0.5,"expireSession":0.15}}

