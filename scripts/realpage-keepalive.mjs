import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const STATE_FILE = ".realpage_state.json";
const REPORT_FILE = "realpage_report.json";
const FAILED_MARKER_FILE = ".realpage_failed";
const SCREENSHOT_DIR = "screenshots";

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function nowUtc() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hashId(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function githubRunUrl() {
  const server = env("GITHUB_SERVER_URL", "https://github.com");
  const repo = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repo || !runId) return "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "target";
}

function toArray(value, fallback = []) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value) return [value];
  return fallback;
}

function normalizeTarget(item, index) {
  const defaultTimeoutMs = Number(env("DEFAULT_TIMEOUT_MS", "60000"));
  const defaultWaitUntil = env("DEFAULT_WAIT_UNTIL", "domcontentloaded");
  const defaultMaxRetries = Number(env("DEFAULT_MAX_RETRIES", "1"));

  if (typeof item === "string") {
    return {
      name: `Target ${index + 1}`,
      url: item,
      timeoutMs: defaultTimeoutMs,
      waitUntil: defaultWaitUntil,
      maxRetries: defaultMaxRetries,
      viewport: { width: 1365, height: 768 },
      screenshot: true,
      fullPageScreenshot: true,
      expectedSelector: "body",
      login: null
    };
  }

  return {
    name: item.name || `Target ${index + 1}`,
    url: item.url,
    timeoutMs: item.timeoutMs || defaultTimeoutMs,
    waitUntil: item.waitUntil || defaultWaitUntil,
    maxRetries: item.maxRetries || defaultMaxRetries,

    viewport: item.viewport || { width: 1365, height: 768 },
    userAgent:
      item.userAgent ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

    screenshot: item.screenshot !== false,
    fullPageScreenshot: item.fullPageScreenshot !== false,

    expectedTitleIncludes: item.expectedTitleIncludes || null,
    expectedUrlIncludes: item.expectedUrlIncludes || null,
    expectedText: item.expectedText || null,
    forbiddenText: item.forbiddenText || null,
    expectedSelector: item.expectedSelector || "body",

    clickSelector: item.clickSelector || null,
    waitAfterClickMs: item.waitAfterClickMs || 0,

    login: item.login || null,

    extraHeaders: item.extraHeaders || {},
    cookies: item.cookies || []
  };
}

function loadTargets() {
  const manualUrl = env("MANUAL_TARGET_URL");

  if (manualUrl) {
    return [
      normalizeTarget(
        {
          name: "Manual Real Page",
          url: manualUrl,
          expectedSelector: "body",
          screenshot: true,
          fullPageScreenshot: true
        },
        0
      )
    ];
  }

  const raw = env("TARGETS_JSON");
  if (!raw) {
    throw new Error("未配置 REALPAGE_TARGETS_JSON。请在 GitHub Secrets 里配置真实业务页面目标。");
  }

  const parsed = safeJsonParse(raw, null);
  if (!Array.isArray(parsed)) {
    throw new Error("REALPAGE_TARGETS_JSON 必须是 JSON 数组。");
  }

  return parsed.map((item, index) => normalizeTarget(item, index));
}

async function locatorExists(page, selector, timeoutMs = 2500) {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
    return locator;
  } catch {
    return null;
  }
}

async function clickFirstVisible(page, selectors, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const label = options.label || "element";

  console.log(`[keepalive] Trying to click: ${label}`);

  for (const selector of selectors) {
    console.log(`[keepalive]   selector: ${selector}`);

    const locator = await locatorExists(page, selector, timeoutMs);
    if (!locator) continue;

    try {
      await locator.click({ timeout: timeoutMs });
      console.log(`[keepalive] Clicked ${label} with selector: ${selector}`);
      return selector;
    } catch (error) {
      console.log(`[keepalive] Click failed for selector ${selector}: ${error.message}`);
    }
  }

  throw new Error(`未找到或无法点击：${label}。尝试过的选择器：${selectors.join(" | ")}`);
}

async function fillFirstVisible(page, selectors, value, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const label = options.label || "input";

  console.log(`[keepalive] Trying to fill: ${label}`);

  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      console.log(`[keepalive]   selector: ${selector}`);

      try {
        const locator = page.locator(selector).first();

        const count = await locator.count().catch(() => 0);
        if (count <= 0) continue;

        await locator.waitFor({ state: "attached", timeout: 1500 }).catch(() => {});

        const visible = await locator.isVisible().catch(() => false);
        const enabled = await locator.isEnabled().catch(() => false);

        console.log(`[keepalive]   found selector=${selector}, visible=${visible}, enabled=${enabled}`);

        if (!enabled) {
          lastError = `selector ${selector} found but not enabled`;
          continue;
        }

        await locator.click({ timeout: 3000 }).catch(() => {});
        await locator.fill(value, { timeout: 5000 });

        console.log(`[keepalive] Filled ${label} with selector: ${selector}`);
        return selector;
      } catch (error) {
        lastError = error.message;
        console.log(`[keepalive] Fill failed for selector ${selector}: ${error.message}`);
      }
    }

    await sleep(1000);
  }

  throw new Error(
    `未找到或无法填写：${label}。尝试过的选择器：${selectors.join(" | ")}。最后错误：${lastError}`
  );
}

async function takeScreenshot(page, target, suffix = "") {
  if (!target.screenshot) return null;

  ensureDir(SCREENSHOT_DIR);

  const id = hashId(`${target.name}|${target.url}`);
  const safeName = sanitizeFileName(target.name);
  const fileName = `${safeName}_${id}${suffix}.png`;
  const screenshotPath = path.join(SCREENSHOT_DIR, fileName);

  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: target.fullPageScreenshot,
      timeout: 10000
    });
    console.log(`[keepalive] Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } catch (error) {
    console.log(`[keepalive] Screenshot failed: ${error.message}`);
    return null;
  }
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function extractLinksFromText(text) {
  const decoded = decodeHtmlEntities(text || "");
  const links = new Set();

  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  for (const match of decoded.matchAll(hrefRegex)) {
    links.add(match[1]);
  }

  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  for (const match of decoded.matchAll(urlRegex)) {
    links.add(match[0]);
  }

  return [...links]
    .map((link) => decodeHtmlEntities(link).replace(/[)\].,;]+$/g, ""))
    .filter((link) => {
      try {
        new URL(link);
        return true;
      } catch {
        return false;
      }
    });
}

function linkMatches(link, magicLinkConfig) {
  const hostIncludes = toArray(magicLinkConfig.linkHostIncludes, []);
  const linkIncludes = toArray(magicLinkConfig.linkIncludes, []);

  let url;
  try {
    url = new URL(link);
  } catch {
    return false;
  }

  const lowerLink = link.toLowerCase();
  const lowerHost = url.hostname.toLowerCase();
  const lowerPath = url.pathname.toLowerCase();

  const blockedHosts = [
    "ea.pstmrk.it",
    "static.z.computer"
  ];

  const blockedExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".css",
    ".js"
  ];

  if (blockedHosts.some((host) => lowerHost.includes(host))) {
    return false;
  }

  if (blockedExtensions.some((ext) => lowerPath.endsWith(ext))) {
    return false;
  }

  if (hostIncludes.length > 0) {
    const hostOk = hostIncludes.some((item) =>
      lowerHost.includes(String(item).toLowerCase())
    );
    if (!hostOk) return false;
  }

  if (linkIncludes.length > 0) {
    const linkOk = linkIncludes.some((item) =>
      lowerLink.includes(String(item).toLowerCase())
    );
    if (!linkOk) return false;
  }

  return true;
}

function messageMatches(parsed, magicLinkConfig, startedAtMs) {
  const subjectIncludes = toArray(magicLinkConfig.subjectIncludes, []);
  const fromIncludes = toArray(magicLinkConfig.fromIncludes, []);

  const subject = String(parsed.subject || "");
  const fromText = String(parsed.from?.text || "");
  const dateMs = parsed.date ? parsed.date.getTime() : 0;

  const newerThanMs = startedAtMs - Number(magicLinkConfig.allowOlderByMs || 120000);
  if (dateMs && dateMs < newerThanMs) return false;

  if (subjectIncludes.length > 0) {
    const ok = subjectIncludes.some((item) =>
      subject.toLowerCase().includes(String(item).toLowerCase())
    );
    if (!ok) return false;
  }

  if (fromIncludes.length > 0) {
    const ok = fromIncludes.some((item) =>
      fromText.toLowerCase().includes(String(item).toLowerCase())
    );
    if (!ok) return false;
  }

  return true;
}

async function fetchMagicLinkFromMailbox(magicLinkConfig, startedAtMs) {
  const user = env(magicLinkConfig.mailboxUserEnv || "MAILBOX_EMAIL");
  const pass = env(magicLinkConfig.mailboxPasswordEnv || "MAILBOX_APP_PASSWORD");

  if (!user) throw new Error(`邮箱账号 Secret 为空：${magicLinkConfig.mailboxUserEnv || "MAILBOX_EMAIL"}`);
  if (!pass) throw new Error(`邮箱 App Password Secret 为空：${magicLinkConfig.mailboxPasswordEnv || "MAILBOX_APP_PASSWORD"}`);

  const host = magicLinkConfig.imapHost || "imap.qq.com";
  const port = Number(magicLinkConfig.imapPort || 993);
  const secure = magicLinkConfig.imapSecure !== false;

  const pollTimeoutMs = Number(magicLinkConfig.pollTimeoutMs || 180000);
  const pollIntervalMs = Number(magicLinkConfig.pollIntervalMs || 10000);
  const mailbox = magicLinkConfig.mailbox || "INBOX";

  const deadline = Date.now() + pollTimeoutMs;
  let lastSeenSubjects = [];

  console.log(`[keepalive] Connecting mailbox via IMAP: ${host}:${port}, mailbox=${mailbox}`);
  console.log(`[keepalive] Polling magic link email for up to ${pollTimeoutMs}ms`);

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: {
        user,
        pass
      },
      logger: false
    });

    try {
      await client.connect();
      await client.mailboxOpen(mailbox);

      const sinceDate = new Date(startedAtMs - Number(magicLinkConfig.allowOlderByMs || 120000));
      const uids = await client.search({ since: sinceDate });

      const recentUids = uids.slice(-20).reverse();
      console.log(`[keepalive] Recent candidate emails: ${recentUids.length}`);

      for await (const msg of client.fetch(recentUids, {
        uid: true,
        envelope: true,
        source: true
      })) {
        const parsed = await simpleParser(msg.source);

        const subject = String(parsed.subject || "");
        const fromText = String(parsed.from?.text || "");
        lastSeenSubjects.push(subject);

        console.log(`[keepalive] Checking email subject="${subject}", from="${fromText}"`);

        if (!messageMatches(parsed, magicLinkConfig, startedAtMs)) {
          continue;
        }

        const content = [
          parsed.html || "",
          parsed.textAsHtml || "",
          parsed.text || ""
        ].join("\n");

        const links = extractLinksFromText(content);

        console.log(`[keepalive] Candidate links in matching email: ${links.length}`);
        for (const link of links) {
          console.log(`[keepalive] Candidate link host/path: ${maskUrl(link)}`);
        }

        const matched = links.find((link) => linkMatches(link, magicLinkConfig));

        if (matched) {
          console.log(`[keepalive] Selected magic link host/path: ${maskUrl(matched)}`);
          await client.logout().catch(() => {});
          console.log(`[keepalive] Magic link found: ${maskUrl(matched)}`);
          return matched;
        }
      }

      await client.logout().catch(() => {});
    } catch (error) {
      console.log(`[keepalive] Mailbox polling error: ${error.message}`);
      try {
        await client.logout();
      } catch {}
    }

    await sleep(pollIntervalMs);
  }

  const tailSubjects = lastSeenSubjects.slice(-10).join(" | ");
  throw new Error(`等待登录邮件超时。最近看到的邮件主题：${tailSubjects}`);
}

async function loginWithEmailMagicLink(page, target) {
  const login = target.login;
  const startedAtMs = Date.now();

  console.log(`[keepalive] Opening login URL: ${login.loginUrl || target.url}`);

  await page.goto(login.loginUrl || target.url, {
    waitUntil: login.waitUntil || "domcontentloaded",
    timeout: target.timeoutMs
  });

  await page.waitForLoadState("domcontentloaded", { timeout: target.timeoutMs }).catch(() => {});
  await sleep(login.waitAfterOpenMs || 1500);

  const emailLinkButtonSelectors = toArray(login.emailLinkButtonSelectors || login.emailLinkButtonSelector, [
    "button:has-text(\"Email me a link\")",
    "text=Email me a link",
    "button:has-text(\"Email\")",
    "text=Email",
    "button:has-text(\"Continue with email\")",
    "text=Continue with email",
    "button:has-text(\"Sign in with email\")",
    "text=Sign in with email"
  ]);

  console.log("[keepalive] Step 1: clicking Email me a link");
  await clickFirstVisible(page, emailLinkButtonSelectors, {
    timeoutMs: login.emailLinkButtonTimeoutMs || 10000,
    label: "Email me a link 按钮"
  });

  await sleep(login.waitAfterEmailLinkClickMs || 1500);

  const email = env(login.emailEnv || "APP_LOGIN_EMAIL");
  if (!email) throw new Error(`登录邮箱 Secret 为空：${login.emailEnv || "APP_LOGIN_EMAIL"}`);

  const emailInputSelectors = toArray(login.emailInputSelectors || login.emailInputSelector, [
    "input[type=\"email\"]",
    "input[name=\"email\"]",
    "input[autocomplete=\"email\"]",
    "input[placeholder*=\"email\" i]",
    "input[aria-label*=\"email\" i]",
    "input"
  ]);

  console.log("[keepalive] Step 2: filling email address");
  await fillFirstVisible(page, emailInputSelectors, email, {
    timeoutMs: login.emailInputTimeoutMs || 15000,
    label: "邮箱输入框"
  });

  const emailSubmitSelectors = toArray(login.emailSubmitSelectors || login.emailSubmitSelector, [
    "button:has-text(\"Email me a link\")",
    "button:has-text(\"Send\")",
    "button:has-text(\"Continue\")",
    "button:has-text(\"Submit\")",
    "text=Email me a link",
    "text=Send",
    "text=Continue",
    "button[type=\"submit\"]"
  ]);

  console.log("[keepalive] Step 3: submitting email link request");
  await clickFirstVisible(page, emailSubmitSelectors, {
    timeoutMs: login.emailSubmitTimeoutMs || 15000,
    label: "发送登录链接按钮"
  });

  await sleep(login.waitAfterSubmitMs || 5000);

  if (!login.magicLink) {
    throw new Error("login.magicLink 未配置，无法读取邮箱里的登录链接。");
  }

  console.log("[keepalive] Step 4: polling mailbox for magic link email");
  const magicLink = await fetchMagicLinkFromMailbox(login.magicLink, startedAtMs);

  console.log(`[keepalive] Step 5: opening magic link: ${maskUrl(magicLink)}`);
  await page.goto(magicLink, {
    waitUntil: target.waitUntil || "domcontentloaded",
    timeout: target.timeoutMs
  });

  await page.waitForLoadState("domcontentloaded", { timeout: target.timeoutMs }).catch(() => {});
  await sleep(login.waitAfterMagicLinkOpenMs || 8000);

  if (login.successSelector) {
    console.log(`[keepalive] Waiting success selector: ${login.successSelector}`);
    await page.waitForSelector(login.successSelector, {
      timeout: login.successTimeoutMs || 30000
    });
  }

  console.log("[keepalive] Email magic link login flow finished.");
}

async function loginIfNeeded(page, target) {
  if (!target.login) {
    console.log("[keepalive] No login config, skip login.");
    return;
  }

  const method = target.login.method || "email_magic_link";

  if (method === "email_magic_link") {
    await loginWithEmailMagicLink(page, target);
    return;
  }

  throw new Error(`不支持的 login.method：${method}`);
}

async function evaluatePage(page, target) {
  console.log("[keepalive] Evaluating target page.");

  const title = await page.title().catch(() => "");
  const currentUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");

  console.log(`[keepalive] Page title: ${title}`);
  console.log(`[keepalive] Page URL: ${currentUrl}`);

  if (target.expectedTitleIncludes && !title.includes(target.expectedTitleIncludes)) {
    return {
      ok: false,
      reason: `页面标题不符合预期：expected title includes "${target.expectedTitleIncludes}", actual "${title}"`,
      title,
      currentUrl
    };
  }

  if (target.expectedUrlIncludes && !currentUrl.includes(target.expectedUrlIncludes)) {
    return {
      ok: false,
      reason: `当前 URL 不符合预期：expected url includes "${target.expectedUrlIncludes}", actual "${currentUrl}"`,
      title,
      currentUrl
    };
  }

  if (target.expectedText && !bodyText.includes(target.expectedText)) {
    return {
      ok: false,
      reason: `页面未找到预期文字：${target.expectedText}`,
      title,
      currentUrl
    };
  }

  if (target.forbiddenText && bodyText.includes(target.forbiddenText)) {
    return {
      ok: false,
      reason: `页面出现禁止文字：${target.forbiddenText}`,
      title,
      currentUrl
    };
  }

  if (target.expectedSelector) {
    const count = await page.locator(target.expectedSelector).count().catch(() => 0);
    if (count <= 0) {
      return {
        ok: false,
        reason: `页面未找到预期元素：${target.expectedSelector}`,
        title,
        currentUrl
      };
    }
  }

  return {
    ok: true,
    reason: "OK",
    title,
    currentUrl
  };
}

async function checkTarget(browser, target) {
  const id = hashId(`${target.name}|${target.url}`);
  const startedAt = Date.now();
  let lastError = null;
  let lastResult = null;
  let screenshotPath = null;

  console.log(`[keepalive] Begin target: ${target.name}`);
  console.log(`[keepalive] Target URL: ${target.url}`);
  console.log(`[keepalive] Max retries: ${target.maxRetries}`);

  for (let attempt = 1; attempt <= target.maxRetries; attempt++) {
    console.log(`[keepalive] Attempt ${attempt}/${target.maxRetries}`);

    const context = await browser.newContext({
      viewport: target.viewport,
      userAgent: target.userAgent,
      extraHTTPHeaders: target.extraHeaders || {},
      ignoreHTTPSErrors: true
    });

    if (Array.isArray(target.cookies) && target.cookies.length > 0) {
      await context.addCookies(target.cookies);
    }

    const page = await context.newPage();

    page.setDefaultTimeout(target.timeoutMs);
    page.setDefaultNavigationTimeout(target.timeoutMs);

    try {
      await loginIfNeeded(page, target);

      console.log(`[keepalive] Going to final target URL: ${target.url}`);
      const response = await page.goto(target.url, {
        waitUntil: target.waitUntil,
        timeout: target.timeoutMs
      });

      const status = response ? response.status() : null;

      if (target.clickSelector) {
        console.log(`[keepalive] Clicking post-login selector: ${target.clickSelector}`);
        await page.click(target.clickSelector, { timeout: 10000 });
        if (target.waitAfterClickMs) await sleep(target.waitAfterClickMs);
      }

      await page.waitForLoadState("domcontentloaded", { timeout: target.timeoutMs }).catch(() => {});

      const evaluation = await evaluatePage(page, target);

      screenshotPath = await takeScreenshot(page, target, evaluation.ok ? "" : "_failed");

      const latencyMs = Date.now() - startedAt;

      lastResult = {
        targetId: id,
        name: target.name,
        url: target.url,
        ok: evaluation.ok,
        reason: evaluation.reason,
        status,
        title: evaluation.title || "",
        finalUrl: evaluation.currentUrl || page.url(),
        latencyMs,
        attempts: attempt,
        screenshotPath,
        checkedAtUtc: nowUtc()
      };

      await context.close();

      console.log(`[keepalive] Target result: ok=${lastResult.ok}, reason=${lastResult.reason}`);

      if (evaluation.ok) return lastResult;

      lastError = evaluation.reason;
    } catch (error) {
      lastError = `${error.name || "Error"}: ${error.message || String(error)}`;
      console.log(`[keepalive] Target error: ${lastError}`);

      screenshotPath = await takeScreenshot(page, target, "_error");

      await context.close().catch(() => {});
    }

    if (attempt < target.maxRetries) {
      await sleep(3000 * attempt);
    }
  }

  return {
    targetId: id,
    name: target.name,
    url: target.url,
    ok: false,
    reason: lastError || "Unknown error",
    status: lastResult?.status || null,
    title: lastResult?.title || "",
    finalUrl: lastResult?.finalUrl || "",
    latencyMs: Date.now() - startedAt,
    attempts: target.maxRetries,
    screenshotPath,
    checkedAtUtc: nowUtc()
  };
}

function detectChanges(results, previousState) {
  const previousTargets = previousState.targets || {};
  const changes = [];

  for (const result of results) {
    const old = previousTargets[result.targetId];

    if (!old) {
      if (!result.ok) {
        changes.push({
          type: "new_failure",
          result
        });
      }
      continue;
    }

    if (Boolean(old.ok) !== Boolean(result.ok)) {
      changes.push({
        type: result.ok ? "recovered" : "new_failure",
        result
      });
    }
  }

  return changes;
}

function saveState(results, previousState) {
  const previousTargets = previousState.targets || {};
  const targets = {};

  for (const result of results) {
    const old = previousTargets[result.targetId];

    targets[result.targetId] = {
      name: result.name,
      url: result.url,
      ok: result.ok,
      reason: result.reason,
      status: result.status,
      title: result.title,
      finalUrl: result.finalUrl,
      latencyMs: result.latencyMs,
      lastCheckedAtUtc: result.checkedAtUtc,
      changedAtUtc:
        old && Boolean(old.ok) === Boolean(result.ok)
          ? old.changedAtUtc || result.checkedAtUtc
          : result.checkedAtUtc
    };
  }

  writeJson(STATE_FILE, {
    updatedAtUtc: nowUtc(),
    targets
  });
}

function buildReport(results, changes) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const latencies = results.map((r) => r.latencyMs).filter((v) => typeof v === "number");
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  return {
    checkedAtUtc: nowUtc(),
    summary: {
      total: results.length,
      ok,
      failed,
      avgLatencyMs,
      notifyMode: env("NOTIFY_MODE", "failure"),
      githubRunUrl: githubRunUrl()
    },
    changes: changes.map((c) => ({
      type: c.type,
      name: c.result.name,
      url: c.result.url,
      reason: c.result.reason
    })),
    results
  };
}

function markdownTable(results) {
  const lines = [
    "| 状态 | 页面 | HTTP | 延迟 | 重试 | 说明 | 截图 |",
    "|---|---|---:|---:|---:|---|---|"
  ];

  for (const r of results) {
    const reason = String(r.reason || "").replace(/\|/g, "\\|");
    lines.push(
      `| ${r.ok ? "✅ OK" : "❌ FAIL"} | ${r.name} | ${r.status ?? "-"} | ${r.latencyMs} ms | ${r.attempts} | ${reason} | ${r.screenshotPath || "-"} |`
    );
  }

  return lines.join("\n");
}

function writeGithubSummary(report) {
  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (!summaryPath) return;

  const title = report.summary.failed === 0 ? "✅ 真实业务界面保活正常" : "⚠️ 真实业务界面保活异常";

  const lines = [
    `# ${title}`,
    "",
    `- 检查时间 UTC：\`${report.checkedAtUtc}\``,
    `- 页面总数：\`${report.summary.total}\``,
    `- 正常：\`${report.summary.ok}\``,
    `- 异常：\`${report.summary.failed}\``,
    `- 平均耗时：\`${report.summary.avgLatencyMs} ms\``,
    `- 通知模式：\`${report.summary.notifyMode}\``
  ];

  if (report.summary.githubRunUrl) {
    lines.push(`- GitHub Run：${report.summary.githubRunUrl}`);
  }

  if (report.changes.length > 0) {
    lines.push("", "## 状态变化");
    for (const c of report.changes) {
      lines.push(c.type === "recovered" ? `- 🟢 恢复：**${c.name}**` : `- 🔴 新故障：**${c.name}**，${c.reason}`);
    }
  }

  lines.push("", "## 页面检查结果", "", markdownTable(report.results), "");

  fs.appendFileSync(summaryPath, lines.join("\n"), "utf8");
}

function shouldNotify(report) {
  const mode = env("NOTIFY_MODE", "failure").toLowerCase();

  if (mode === "off") return false;
  if (mode === "always") return true;
  if (mode === "failure") return report.summary.failed > 0;
  if (mode === "change") return report.changes.length > 0;

  return report.summary.failed > 0;
}

function buildMessage(report) {
  const s = report.summary;
  const headline = s.failed === 0
    ? "✅ 真实业务界面保活正常"
    : `⚠️ 真实业务界面异常：${s.failed}/${s.total} 个页面失败`;

  const lines = [
    headline,
    "",
    `时间 UTC：${report.checkedAtUtc}`,
    `正常/总数：${s.ok}/${s.total}`,
    `平均耗时：${s.avgLatencyMs} ms`,
    `通知模式：${s.notifyMode}`
  ];

  if (report.changes.length > 0) {
    lines.push("", "状态变化：");
    for (const c of report.changes) {
      lines.push(c.type === "recovered" ? `🟢 恢复：${c.name}` : `🔴 新故障：${c.name}：${c.reason}`);
    }
  }

  const failed = report.results.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push("", "异常详情：");
    for (const r of failed.slice(0, 8)) {
      lines.push(`- ${r.name}: HTTP=${r.status ?? "-"}, ${r.latencyMs} ms, ${r.reason}`);
    }
  }

  if (s.githubRunUrl) {
    lines.push("", `GitHub Run：${s.githubRunUrl}`);
  }

  return lines.join("\n");
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "GitHub-Actions-RealPage-Keepalive/1.0"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text().catch(() => "");
  return {
    ok: res.ok,
    status: res.status,
    text
  };
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function notifyTelegram(message) {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return null;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await postJson(url, {
    chat_id: chatId,
    text: `<pre>${escapeHtml(message)}</pre>`,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  return res.ok ? "telegram:ok" : `telegram:failed:${res.status}:${res.text}`;
}

async function notifyDiscord(message) {
  const url = env("DISCORD_WEBHOOK_URL");
  if (!url) return null;

  const res = await postJson(url, {
    username: "RealPage Keepalive",
    content: message.slice(0, 1900)
  });

  return res.ok ? "discord:ok" : `discord:failed:${res.status}:${res.text}`;
}

async function notifySlack(message) {
  const url = env("SLACK_WEBHOOK_URL");
  if (!url) return null;

  const res = await postJson(url, {
    text: message
  });

  return res.ok ? "slack:ok" : `slack:failed:${res.status}:${res.text}`;
}

async function sendNotifications(report) {
  if (!shouldNotify(report)) return ["notify:skipped"];

  const message = buildMessage(report);
  const outputs = [];

  for (const fn of [notifyTelegram, notifyDiscord, notifySlack]) {
    try {
      const result = await fn(message);
      if (result) outputs.push(result);
    } catch (error) {
      outputs.push(`notify:error:${error.message}`);
    }
  }

  if (outputs.length === 0) outputs.push("notify:no_channel_configured");
  return outputs;
}

function updateFailureMarker(report) {
  if (report.summary.failed > 0) {
    fs.writeFileSync(FAILED_MARKER_FILE, "failed\n", "utf8");
  } else if (fs.existsSync(FAILED_MARKER_FILE)) {
    fs.unlinkSync(FAILED_MARKER_FILE);
  }
}

async function main() {
  ensureDir(SCREENSHOT_DIR);

  console.log("[keepalive] Script started.");
  console.log(`[keepalive] UTC now: ${nowUtc()}`);

  await sleep(Math.floor(Math.random() * 1500));

  const previousState = readJson(STATE_FILE, { targets: {} });
  const targets = loadTargets();

  console.log(`[keepalive] Loaded targets: ${targets.length}`);
  for (const target of targets) {
    console.log(`[keepalive] Target: ${target.name} -> ${target.url}`);
  }

  const browser = await chromium.launch({
    headless: true
  });

  const results = [];

  for (const target of targets) {
    console.log(`[keepalive] Checking target: ${target.name}`);
    const result = await checkTarget(browser, target);
    console.log(`[keepalive] Result for ${target.name}: ok=${result.ok}, reason=${result.reason}`);
    results.push(result);
  }

  await browser.close();

  results.sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));

  const changes = detectChanges(results, previousState);
  saveState(results, previousState);

  const report = buildReport(results, changes);
  writeGithubSummary(report);

  const notifyOutputs = await sendNotifications(report);
  report.notificationOutputs = notifyOutputs;

  writeJson(REPORT_FILE, report);
  updateFailureMarker(report);

  console.log("[keepalive] Final summary:");
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("notificationOutputs:", notifyOutputs);
}

main().catch((error) => {
  const report = {
    checkedAtUtc: nowUtc(),
    fatalError: error.message,
    stack: error.stack
  };

  writeJson(REPORT_FILE, report);
  fs.writeFileSync(FAILED_MARKER_FILE, "fatal\n", "utf8");

  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    fs.appendFileSync(
      summaryPath,
      `# ❌ 真实业务界面保活脚本异常\n\n\`${error.message}\`\n`,
      "utf8"
    );
  }

  console.error(error);
  process.exit(0);
});
