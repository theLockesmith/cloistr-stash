/**
 * Playwright probe: reproduce React error #300 on stash mobile.
 * 
 * Strategy:
 * 1. Login to signer to get an auth_token cookie
 * 2. Navigate to local dev server with that cookie
 * 3. Capture all console errors (React dev build prints full messages + component names)
 * 4. Wait for either error or success
 */
const { chromium } = require('playwright');
const fs = require('fs');

// Read credentials from file - never echo them
const credFile = fs.readFileSync(process.env.HOME + '/.credentials/cliostr-test-account', 'utf8').trim().split('\n');
const USER = credFile[0];
const PASS = credFile[1];

(async () => {
  const browser = await chromium.launch({ headless: true });
  
  // Step 1: Login to signer to get the auth cookie
  const loginCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    // Match mobile UA
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const loginPage = await loginCtx.newPage();
  
  console.log('[probe] Logging in to signer...');
  
  // Login via API to get auth_token cookie
  const loginResp = await loginPage.request.post('https://signer.cloistr.xyz/api/v1/users/login', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ username: USER, password: PASS }),
  });
  
  const loginStatus = loginResp.status();
  console.log('[probe] Login status:', loginStatus);
  
  if (loginStatus !== 200) {
    const body = await loginResp.text();
    console.error('[probe] Login failed:', body.slice(0, 200));
    await browser.close();
    process.exit(1);
  }
  
  const loginBody = await loginResp.json();
  console.log('[probe] Login success, pubkey:', loginBody.pubkey ? loginBody.pubkey.slice(0,16) + '...' : 'n/a');
  
  // Get cookies from this context
  const cookies = await loginCtx.cookies();
  console.log('[probe] Cookies after login:', cookies.map(c => c.name).join(', '));
  
  await loginPage.close();
  
  // Step 2: Create a new context with those cookies, navigate to the dev server
  const stashCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  
  // Add production cookies to dev context
  // The auth_token cookie is on .cloistr.xyz - we need to set it for localhost too
  const authCookies = cookies.map(c => ({
    ...c,
    domain: 'localhost',
    secure: false,
  }));
  await stashCtx.addCookies(authCookies);
  
  const stashPage = await stashCtx.newPage();
  
  const errors = [];
  const consoleMessages = [];
  
  // Capture all console messages
  stashPage.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    consoleMessages.push({ type, text });
    if (type === 'error' || text.includes('react') || text.includes('React') || text.includes('hook') || text.includes('Hook') || text.includes('#300') || text.includes('Rendered')) {
      console.log(`[console:${type}] ${text}`);
    }
  });
  
  stashPage.on('pageerror', (err) => {
    console.log('[pageerror]', err.message);
    errors.push(err.message);
  });
  
  console.log('[probe] Navigating to dev server...');
  await stashPage.goto('http://localhost:3001/', { waitUntil: 'networkidle', timeout: 10000 }).catch(e => {
    console.log('[probe] Initial load timeout/error:', e.message.slice(0, 100));
  });
  
  // Check initial state
  const rootLen = await stashPage.evaluate(() => document.getElementById('root')?.innerHTML?.length ?? 0);
  console.log('[probe] Initial rootLen:', rootLen);
  
  // Wait for connecting state
  const connectingVisible = await stashPage.locator('.stash-connecting').isVisible().catch(() => false);
  console.log('[probe] .stash-connecting visible:', connectingVisible);
  
  // Wait up to 35s for SSO restore to complete (either error or success)
  console.log('[probe] Waiting up to 35s for SSO restore...');
  
  let resolved = false;
  for (let i = 0; i < 35; i++) {
    await new Promise(r => setTimeout(r, 1000));
    
    const rootLen2 = await stashPage.evaluate(() => document.getElementById('root')?.innerHTML?.length ?? 0);
    const domCount = await stashPage.evaluate(() => document.querySelectorAll('*').length);
    const hasError = errors.length > 0;
    
    if (i % 5 === 0 || hasError) {
      console.log(`[probe] t=${i+1}s rootLen=${rootLen2} domNodes=${domCount} errors=${errors.length}`);
    }
    
    if (hasError) {
      console.log('[probe] Error detected! Stopping wait.');
      resolved = true;
      break;
    }
    
    // Check if workspace rendered (success)
    const workspaceVisible = await stashPage.locator('.stash-workspace').isVisible().catch(() => false);
    if (workspaceVisible) {
      console.log(`[probe] SUCCESS: workspace visible at t=${i+1}s, rootLen=${rootLen2}, domNodes=${domCount}`);
      resolved = true;
      break;
    }
  }
  
  // Final state
  const finalRootLen = await stashPage.evaluate(() => document.getElementById('root')?.innerHTML?.length ?? 0);
  const finalDomCount = await stashPage.evaluate(() => document.querySelectorAll('*').length);
  console.log(`[probe] Final state: rootLen=${finalRootLen} domNodes=${finalDomCount}`);
  
  if (errors.length > 0) {
    console.log('\n[probe] === PAGE ERRORS ===');
    errors.forEach(e => console.log(e));
  }
  
  // Print all error-level console messages
  const errorConsole = consoleMessages.filter(m => m.type === 'error');
  if (errorConsole.length > 0) {
    console.log('\n[probe] === CONSOLE ERRORS ===');
    errorConsole.forEach(m => console.log(m.text));
  }
  
  await browser.close();
})().catch(e => {
  console.error('[probe] Fatal:', e.message);
  process.exit(1);
});
