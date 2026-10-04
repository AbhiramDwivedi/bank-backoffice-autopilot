## 1-discover

    npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation --app-command powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1 --runs-dir runs-live/ev/discovery-desktop discover --goal Sign on to the Teller Workstation, look up member {memberId} and read their savings balance. --input memberId=12345 --output savingsBalance:number --id teller-lookup-savings-balance --read-only --auto-operator approve --operator-port 0 --out evidence/followups/discovery-desktop/capability.json

## 2-replay-other-member

    npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation --app-command powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1 --runs-dir runs-live/ev/discovery-desktop replay evidence/followups/discovery-desktop/capability.json --input memberId=10002 --operator-port 0

## 3-replay-unknown-member

    npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation --app-command powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1 --runs-dir runs-live/ev/discovery-desktop replay evidence/followups/discovery-desktop/capability.json --input memberId=99999 --operator-port 0

## 4-replay-other-member-json

    npm run --silent cli -- --policy policies/desktop.yaml --base-url desktop://tellerworkstation --app-command powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/mock-desktop/teller.ps1 --runs-dir runs-live/ev/discovery-desktop replay evidence/followups/discovery-desktop/capability.json --input memberId=10002 --operator-port 0 --json

