## 1-discover

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target discover --goal Sign in and read the price of the product named {productName} on the inventory page. --input productName=Sauce Labs Backpack --output price:number --id read-product-price --entry / --secret SAUCE_USER --secret SAUCE_PASSWORD --vendor Demo storefront --product Demo storefront --read-only --no-optimize --auto-operator approve --operator-port 0 --out evidence/followups/public-target/capability.json

## 2-replay-same-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target replay evidence/followups/public-target/capability.json --input productName=Sauce Labs Backpack --operator-port 0

## 3-replay-other-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target replay evidence/followups/public-target/capability.json --input productName=Sauce Labs Bike Light --operator-port 0

## 4-replay-unlisted-product

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target replay evidence/followups/public-target/capability.json --input productName=Sauce Labs Unicorn Saddle --operator-port 0

## 5-optimize

    npm run --silent cli -- --policy policies/saucedemo.yaml --base-url https://www.saucedemo.com --runs-dir runs-live/ev/public-target optimize evidence/followups/public-target/capability.json --input productName=Sauce Labs Backpack --read-only --trial-delay-ms 2000 --max-trials 3 --verify-runs 1 --out evidence/followups/public-target/capability.optimized.json

