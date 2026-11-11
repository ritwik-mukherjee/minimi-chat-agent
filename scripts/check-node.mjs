// Plain JavaScript on purpose: a Node that cannot read .ts files must still be able to run this check.
const REQUIRED = [26, 13, 0];
const current = process.versions.node.split(".").map(Number);

function isOlder(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

if (isOlder(current, REQUIRED)) {
  console.error(
    `Node ${REQUIRED.join(".")} or newer is required (found ${process.versions.node}). Run \`nvm use\`.`,
  );
  process.exit(1);
}
