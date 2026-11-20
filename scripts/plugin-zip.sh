#!/bin/sh
# Builds public/wp-control-hub.zip with hub.php (WPCH_HUB = this hub's address, from wrangler.jsonc vars.HUB_URL) so sites can pair themselves.
set -e
HUB=$(node -e 'const v=require("fs").readFileSync("wrangler.jsonc","utf8").match(/"HUB_URL":\s*"([^"]*)"/)?.[1]; if(!/^https:\/\/[a-z0-9.-]+$/.test(v||"")) throw new Error("wrangler.jsonc vars.HUB_URL must be https://host"); console.log(v)')
tmp=$(mktemp -d)
cp -R wp-plugin/wp-control-hub "$tmp/"
printf "<?php\n// written by the hub when it built this zip\ndefined('ABSPATH') || exit;\ndefine('WPCH_HUB', '%s');\n" "$HUB" > "$tmp/wp-control-hub/hub.php"
rm -f public/wp-control-hub.zip
(cd "$tmp" && zip -qr - wp-control-hub -x '*.DS_Store') > public/wp-control-hub.zip
rm -rf "$tmp"
