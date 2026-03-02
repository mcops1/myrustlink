// src/stats/moose.js
// Scrapes wipe stats for a player from moose.gg/stats using Puppeteer.
//
// moose.gg is a Blazor Server app (C# + SignalR / Radzen UI) with no public API.
// We automate headless Chromium to:
//   1. Select the Rusty Moose server from the server dropdown
//   2. Select the most recent wipe from the wipe dropdown
//   3. Navigate the PvP, Resources, and Boom tabs to collect:
//        KDR, Sulfur Ore farmed, and Rockets fired
//
// Only works for Rusty Moose servers (moose.gg only tracks their own servers).
//
// Column layout (confirmed via live probe):
//   PvP tab:       Player | KDR | Kills | Deaths | ...
//   Resources tab: Player | Wood | Stone | Metal Ore | Sulfur Ore | HQM Ore | ...
//   Boom tab:      Player | Rocket | H.V. Rocket | Incen. Rocket | ...

'use strict';

const MOOSE_URL = 'https://moose.gg/stats';

/** @type {import('puppeteer').Browser|null} */
let _browser = null;

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  const puppeteer = require('puppeteer');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Rusty Moose server type from a BattleMetrics server name.
 * e.g. "Rusty Moose |US Monthly|" → "US Monthly"
 *      "Rusty Moose |EU Main|"    → "EU Main"
 *
 * @param {string|null} bmServerName
 * @returns {string|null}
 */
function extractServerType(bmServerName) {
  if (!bmServerName) return null;
  const match = bmServerName.match(/\|([^|]+)\|/);
  return match ? match[1].trim() : bmServerName;
}

/**
 * Open a Radzen dropdown by index and click the first option matching textMatch.
 * Uses JS evaluation to bypass Puppeteer click-interactability guards.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} dropdownIndex - 0 = server, 1 = wipe
 * @param {string|null} textMatch - substring to match; null = first item
 * @returns {Promise<string|null>} — the text of the selected item, or null
 */
async function selectDropdown(page, dropdownIndex, textMatch) {
  await page.evaluate((idx) => {
    const dds = document.querySelectorAll('.rz-dropdown');
    if (dds[idx]) dds[idx].click();
  }, dropdownIndex);

  await new Promise((r) => setTimeout(r, 1000));

  const selected = await page.evaluate((match) => {
    const panels = document.querySelectorAll('.rz-dropdown-panel');
    for (const panel of panels) {
      if (!panel.offsetParent) continue; // not visible
      const items = panel.querySelectorAll('.rz-dropdown-item, li');
      for (const item of items) {
        const text = item.textContent.trim();
        if (!match || text.toLowerCase().includes(match.toLowerCase())) {
          item.click();
          return text;
        }
      }
    }
    return null;
  }, textMatch);

  await new Promise((r) => setTimeout(r, 2500));
  return selected;
}

/**
 * Click a tab by its displayed title text.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} tabName
 */
async function clickTab(page, tabName) {
  await page.evaluate((name) => {
    const tabs = document.querySelectorAll('.rz-tabview-title');
    for (const t of tabs) {
      if (t.textContent.trim() === name) { t.click(); return; }
    }
  }, tabName);
  await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Scan all tbody rows for a player name match (case-insensitive substring).
 * Returns an object keyed by column header, or null if not found.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} playerName
 * @returns {Promise<Record<string,string>|null>}
 */
async function findPlayerRow(page, playerName) {
  return page.evaluate((name) => {
    const nameLower = name.toLowerCase();
    const headers   = Array.from(document.querySelectorAll('th'))
      .map((h) => h.innerText.trim())
      .filter(Boolean);
    const rows = Array.from(document.querySelectorAll('tbody tr'));

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map((c) => c.innerText.trim());
      if (cells[0] && cells[0].toLowerCase().includes(nameLower)) {
        const result = { _matchedName: cells[0] };
        headers.forEach((h, i) => { if (i < cells.length) result[h] = cells[i]; });
        return result;
      }
    }
    return null;
  }, playerName);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetch a player's wipe stats from moose.gg/stats.
 *
 * @param {string}      playerName   — Rust player name to look up
 * @param {string|null} bmServerName — BattleMetrics server name (used to pick moose.gg server)
 * @returns {Promise<
 *   { name: string, kdr: string, sulfurOre: string, rockets: string, server: string, wipe: string } |
 *   { error: string }
 * >}
 */
async function getMooseStats(playerName, bmServerName) {
  const browser = await getBrowser();
  const page    = await browser.newPage();

  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[Moose] Loading moose.gg/stats...');
    await page.goto(MOOSE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 5000)); // Blazor init

    // --- Server ---
    const serverType = extractServerType(bmServerName);
    console.log(`[Moose] Selecting server: "${serverType}"`);
    const selectedServer = await selectDropdown(page, 0, serverType);
    if (!selectedServer) {
      return {
        error:
          `Server "${serverType}" not found on moose.gg. ` +
          'moose.gg only tracks Rusty Moose servers (US/EU Monthly, Main, etc.).',
      };
    }
    console.log(`[Moose] Server: ${selectedServer}`);
    await new Promise((r) => setTimeout(r, 1000));

    // --- Wipe (most recent = first item) ---
    const selectedWipe = await selectDropdown(page, 1, null);
    console.log(`[Moose] Wipe: ${selectedWipe}`);
    await new Promise((r) => setTimeout(r, 1000));

    // --- PvP tab → KDR ---
    await clickTab(page, 'PvP');
    const pvpRow = await findPlayerRow(page, playerName);

    if (!pvpRow) {
      return {
        error:
          `Player "${playerName}" not found on ${selectedServer} ` +
          `for wipe starting ${selectedWipe}. ` +
          'Make sure the name is spelled correctly and they have played this wipe.',
      };
    }

    const matchedName = pvpRow._matchedName;
    const kdr         = pvpRow['KDR'] || 'N/A';
    console.log(`[Moose] Found: "${matchedName}" | KDR: ${kdr}`);

    // --- Resources tab → Sulfur Ore ---
    await clickTab(page, 'Resources');
    const resourcesRow = await findPlayerRow(page, playerName);
    const sulfurOre    = (resourcesRow && resourcesRow['Sulfur Ore']) || 'N/A';
    console.log(`[Moose] Sulfur Ore: ${sulfurOre}`);

    // --- Boom tab → Rockets ---
    await clickTab(page, 'Boom');
    const boomRow = await findPlayerRow(page, playerName);
    const rockets  = (boomRow && boomRow['Rocket']) || 'N/A';
    console.log(`[Moose] Rockets: ${rockets}`);

    return { name: matchedName, kdr, sulfurOre, rockets, server: selectedServer, wipe: selectedWipe };
  } finally {
    await page.close();
  }
}

module.exports = { getMooseStats, extractServerType, closeBrowser };
