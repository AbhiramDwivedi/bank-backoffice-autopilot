## 1-discover

    npm run --silent cli -- --runs-dir runs-live/ev/discovery-mock-app discover --goal Log in to the workstation, look up member {memberId} and read their current savings balance and member name. --input memberId=12345 --output savingsBalance:number --output memberName:string --id lookup-member-savings-balance --read-only --auto-operator approve --operator-port 0 --out evidence/followups/discovery-mock-app/capability.json

## 2-replay-other-member

    npm run --silent cli -- --runs-dir runs-live/ev/discovery-mock-app replay evidence/followups/discovery-mock-app/capability.json --input memberId=10002 --operator-port 0

## 3-replay-unknown-member

    npm run --silent cli -- --runs-dir runs-live/ev/discovery-mock-app replay evidence/followups/discovery-mock-app/capability.json --input memberId=99999 --operator-port 0

