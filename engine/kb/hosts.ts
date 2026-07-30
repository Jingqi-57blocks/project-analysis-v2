/**
 * Whether a host a service was seen to reach is a real integration.
 *
 * A URL literal in a codebase is as likely to be a documentation link, a
 * localhost port, an XML namespace, or a template nobody filled in as a system
 * the code actually talks to. Left in the map and the integration list they
 * read as absurd — "this platform connects to Stack Overflow, and to
 * localhost" — so both the stored map and the rendered list drop them through
 * this one predicate, and the count of what was dropped is stated rather than
 * hidden.
 */

const NOT_AN_INTEGRATION =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])|(\.local(:\d+)?$)|^(www\.)?(github|stackoverflow|vuejs|reactjs|npmjs|apidocjs|code\.visualstudio|developer\.mozilla|twitter|x)\.(com|org|net)$/i;

function isPlaceholderHost(host: string): boolean {
  // `xxxx.xxx.com`, `example.com`, `your-domain.com` — a template left unfilled.
  return (
    /^(x+|example|test|foo|bar|your[-_]?\w*)\./i.test(host) ||
    /\bexample\.(com|org)$/i.test(host)
  );
}

/** True when a host is worth showing as something the system connects to. */
export function isRealIntegration(host: string): boolean {
  const bare = host.replace(/:\d+$/, "");
  return !NOT_AN_INTEGRATION.test(host) && !NOT_AN_INTEGRATION.test(bare) && !isPlaceholderHost(host);
}
