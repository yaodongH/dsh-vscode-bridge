const PACKAGE_NAME = 'dsh-vscode-bridge';
/** Cordis companion plugin name. */
const name = 'dsh-vscode-bridge-invariant';
/** Service required before the companion can reserve package ownership. */
const inject = ['invariants'];

/**
 * No runtime invariant: the bridge owns no service state or event protocol of
 * its own — every route sits behind the host's webServer fence, the
 * code-server lifecycle is exercised by the mock end-to-end spec, and the
 * panel's status is a plain snapshot source asserted at the view boundary.
 */
const install = () => {};

const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));

export { name, inject, apply };