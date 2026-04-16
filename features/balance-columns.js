const LEFT_COL_SELECTOR = '#extensions_settings';
const RIGHT_COL_SELECTOR = '#extensions_settings2';
const DEBOUNCE_MS = 200;

let originalChildren = null;
let columnObserver = null;
let debounceTimer = null;

/**
 * Returns true if the element is a built-in extension container
 * (hardcoded in index.html as .extension_container).
 */
function isBuiltIn(el) {
    return el.classList.contains('extension_container');
}

/** Extract the drawer title text for sorting. */
function getDrawerName(el) {
    const b = el.querySelector('.inline-drawer-header b');
    return (b?.textContent ?? '').trim();
}

/**
 * Collect all drawer roots from both columns, excluding our own settings panel.
 * Built-ins first (preserving relative order), then third-party sorted alphabetically.
 */
function getDrawerRoots() {
    const left = document.querySelector(LEFT_COL_SELECTOR);
    const right = document.querySelector(RIGHT_COL_SELECTOR);
    if (!left || !right) return [];

    const collect = (parent) =>
        Array.from(parent.children).filter((el) => {
            return el.matches('.inline-drawer') || !!el.querySelector('.inline-drawer');
        });

    const all = [...collect(left), ...collect(right)];
    const builtIn = all.filter(isBuiltIn);
    const thirdParty = all.filter((el) => !isBuiltIn(el));

    // Sort third-party alphabetically by drawer title
    thirdParty.sort((a, b) => getDrawerName(a).localeCompare(getDrawerName(b)));

    return [...builtIn, ...thirdParty];
}

/**
 * Snapshots the full child list of each column so we can
 * restore the exact original layout later.
 */
export function initBalanceColumns() {
    const left = document.querySelector(LEFT_COL_SELECTOR);
    const right = document.querySelector(RIGHT_COL_SELECTOR);
    if (!left || !right) return;

    originalChildren = {
        left: [...left.children],
        right: [...right.children],
    };
}

/**
 * Distributes drawer roots evenly: ceil(n/2) left, floor(n/2) right.
 * Built-ins come first, then third-party (sorted alphabetically).
 */
function rebalance() {
    const left = document.querySelector(LEFT_COL_SELECTOR);
    const right = document.querySelector(RIGHT_COL_SELECTOR);
    if (!left || !right) return;

    // Disconnect observer while we move elements
    if (columnObserver) columnObserver.disconnect();

    const roots = getDrawerRoots();
    const total = roots.length;

    // Count non-drawer children stuck in each column (never moved by rebalance)
    const leftExtras = Array.from(left.children).filter(
        (el) => !el.matches('.inline-drawer') && !el.querySelector('.inline-drawer'),
    ).length;
    const rightExtras = Array.from(right.children).filter(
        (el) => !el.matches('.inline-drawer') && !el.querySelector('.inline-drawer'),
    ).length;

    // Target equal total visible children per column (drawers + extras)
    const targetLeft = Math.ceil((total + leftExtras + rightExtras) / 2) - leftExtras;
    const midpoint = Math.max(0, Math.min(total, targetLeft));

    roots.forEach((el, i) => {
        if (i < midpoint) {
            left.appendChild(el);
        } else {
            right.appendChild(el);
        }
    });

    // Reconnect observer
    if (columnObserver) startObserving();
}

function startObserving() {
    const left = document.querySelector(LEFT_COL_SELECTOR);
    const right = document.querySelector(RIGHT_COL_SELECTOR);
    if (!left || !right || !columnObserver) return;

    columnObserver.observe(left, { childList: true });
    columnObserver.observe(right, { childList: true });
}

/**
 * Enables column balancing: runs an initial rebalance and watches
 * for new extensions being added (auto-rebalances with debounce).
 */
export function enableBalanceColumns() {
    columnObserver = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(rebalance, DEBOUNCE_MS);
    });

    rebalance();
    startObserving();
}

/**
 * Disables column balancing: restores all drawers to their original
 * positions and stops the observer.
 */
export function disableBalanceColumns() {
    if (columnObserver) {
        columnObserver.disconnect();
        columnObserver = null;
    }
    clearTimeout(debounceTimer);

    if (!originalChildren) return;

    const left = document.querySelector(LEFT_COL_SELECTOR);
    const right = document.querySelector(RIGHT_COL_SELECTOR);
    if (!left || !right) return;

    for (const child of originalChildren.left) {
        left.appendChild(child);
    }
    for (const child of originalChildren.right) {
        right.appendChild(child);
    }
}
