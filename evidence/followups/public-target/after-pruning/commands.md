## 1-discover

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target-after discover --goal Sign in and read the price of the product named {productName} on the inventory page. --input productName=Sauce Labs Backpack --output price:number --id read-product-price --entry / --secret SAUCE_USER --secret SAUCE_PASSWORD --vendor Demo storefront --product Demo storefront --read-only --no-optimize --auto-operator approve --operator-port 0 --out evidence/followups/public-target/after-pruning/capability.json

## 2-replay-same-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target-after replay evidence/followups/public-target/after-pruning/capability.json --input productName=Sauce Labs Backpack --operator-port 0

## 3-replay-other-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target-after replay evidence/followups/public-target/after-pruning/capability.json --input productName=Sauce Labs Bike Light --operator-port 0

## 4-replay-unlisted-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target-after replay evidence/followups/public-target/after-pruning/capability.json --input productName=Sauce Labs Unicorn Saddle --operator-port 0

## 5-validate

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target-after validate evidence/followups/public-target/after-pruning/capability.json

