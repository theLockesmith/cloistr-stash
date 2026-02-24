#!/usr/bin/env node
// Run browser-based crypto tests headlessly with Puppeteer
// Usage: node scripts/run-browser-tests.js [--url http://localhost:8080]

const puppeteer = require('puppeteer');

async function runTests() {
    const args = process.argv.slice(2);
    let baseUrl = 'http://localhost:8080';

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && args[i + 1]) {
            baseUrl = args[i + 1];
            i++;
        }
    }

    console.log(`Running tests at ${baseUrl}/test.html\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Capture console output
    page.on('console', msg => {
        const text = msg.text();
        // Color output based on content
        if (text.includes('✓')) {
            console.log('\x1b[32m%s\x1b[0m', text); // Green
        } else if (text.includes('✗')) {
            console.log('\x1b[31m%s\x1b[0m', text); // Red
        } else if (text.includes('===') || text.includes('---')) {
            console.log('\x1b[33m%s\x1b[0m', text); // Yellow
        } else if (text.includes('RESULTS')) {
            console.log('\x1b[36m%s\x1b[0m', text); // Cyan
        } else {
            console.log(text);
        }
    });

    // Navigate to test page
    await page.goto(`${baseUrl}/test.html`, {
        waitUntil: 'networkidle0',
        timeout: 30000,
    });

    // Wait for page to initialize - check for Crypto module and libsodium
    console.log('Waiting for page initialization...');
    try {
        await page.waitForFunction(() => {
            return typeof Crypto !== 'undefined' &&
                   typeof sodium !== 'undefined' &&
                   Crypto.initialized === true;
        }, {
            timeout: 30000,
            polling: 500,
        });
        console.log('Page initialized successfully.\n');
    } catch (err) {
        // Get more diagnostic info
        const diagnostics = await page.evaluate(() => ({
            hasCrypto: typeof Crypto !== 'undefined',
            hasSodium: typeof sodium !== 'undefined',
            cryptoInitialized: typeof Crypto !== 'undefined' ? Crypto.initialized : 'N/A',
            errors: window.testErrors || [],
        }));
        console.error('Initialization diagnostics:', JSON.stringify(diagnostics, null, 2));
        throw err;
    }

    console.log('Running tests...\n');

    // Run all tests
    const result = await page.evaluate(async () => {
        // Run crypto tests first
        const cryptoResults = await CryptoTests.runAll();

        // Then integration tests
        const integrationResults = await IntegrationTests.runAll();

        return {
            crypto: cryptoResults,
            integration: integrationResults,
            totalPassed: cryptoResults.passed + integrationResults.passed,
            totalFailed: cryptoResults.failed + integrationResults.failed,
        };
    });

    await browser.close();

    // Print summary
    console.log('\n========================================');
    console.log('FINAL SUMMARY');
    console.log('========================================');
    console.log(`Crypto tests: ${result.crypto.passed} passed, ${result.crypto.failed} failed`);
    console.log(`Integration tests: ${result.integration.passed} passed, ${result.integration.failed} failed`);
    console.log('----------------------------------------');
    console.log(`TOTAL: ${result.totalPassed} passed, ${result.totalFailed} failed`);
    console.log('========================================\n');

    // Exit with appropriate code
    process.exit(result.totalFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
