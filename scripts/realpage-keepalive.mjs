import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";

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
  const defaultTimeoutMs = Number(env("DEFAULT_TIMEOUT_MS", "90000"));
  const defaultWaitUntil = env("DEFAULT_WAIT_UNTIL", "domcontentloaded");
  const defaultMaxRetries = Number(env("DEFAULT_MAX_RETRIES", "2"));

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
      expectedSelector: "body"
    };
  }

  const login = item.login || null;

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

    login,

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
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    return locator;
  } catch {
    return null;
  }
}

async function clickFirstVisible(page, selectors, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const label = options.label || "element";

  for (const selector of selectors) {
    const locator = await locatorExists(page, selector, timeoutMs);
    if (!locator) continue;

    try {
      await locator.click({ timeout: timeoutMs });
      return selector;
    } catch {}
  }

  throw new Error(`未找到或无法点击：${label}。尝试过的选择器：${selectors.join(" | ")}`);
}

async function fillFirstVisible(page, selectors, value, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const label = options.label || "input";

  for (const selector of selectors) {
    const locator = await locatorExists(page, selector, timeoutMs);
    if (!locator) continue;

    try {
      await locator.fill(value, { timeout: timeoutMs });
      return selector;
    } catch {}
  }

  throw new Error(`未找到或无法填写：${label}。尝试过的选择器：${selectors.join(" | ")}`);
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
      fullPage: target.fullPageScreenshot
    });
    return screenshotPath;
  } catch {
    return null;
  }
}

async function loginIfNeeded(page, target) {
  if (!target.login) return;

  const login = target.login;

  if (login.loginUrl) {
    await page.goto(login.loginUrl, {
      waitUntil: login.waitUntil || "domcontentloaded",
      timeout: target.timeoutMs
    });
  }

  await page.waitForLoadState("domcontentloaded", { timeout: target.timeoutMs }).catch(() => {});

  let authPage = page;

  const providerSelectors = toArray(login.providerButtonSelectors || login.providerButtonSelector, [
    "button:has-text(\"Sign in with Google\")",
    "button:has-text(\"Sign In with Google\")",
    "button:has-text(\"Continue with Google\")",
    "a:has-text(\"Sign in with Google\")",
    "div:has-text(\"Sign in with Google\")",
    "text=Sign in with Google",
    "text=Continue with Google",
    "[aria-label*=\"Google\"]",
    "[data-provider*=\"google\" i]"
  ]);

  if (providerSelectors.length > 0) {
    const popupPromise = page.waitForEvent("popup", {
      timeout: login.popupTimeoutMs || 8000
    }).catch(() => null);

    await clickFirstVisible(page, providerSelectors, {
      timeoutMs: login.providerButtonTimeoutMs || target.timeoutMs,
      label: "Sign in with Google 按钮"
    });

    const popup = await popupPromise;

    if (popup) {
      authPage = popup;
      await authPage.waitForLoadState("domcontentloaded", {
        timeout: target.timeoutMs
      }).catch(() => {});
    } else {
      authPage = page;
      await authPage.waitForLoadState("domcontentloaded", {
        timeout: target.timeoutMs
      }).catch(() => {});
    }

    if (login.waitAfterProviderClickMs) {
      await sleep(login.waitAfterProviderClickMs);
    }
  }

  const useAnotherAccountSelectors = toArray(login.useAnotherAccountSelectors || login.useAnotherAccountSelector, []);
  if (useAnotherAccountSelectors.length > 0) {
    try {
      await clickFirstVisible(authPage, useAnotherAccountSelectors, {
        timeoutMs: login.useAnotherAccountTimeoutMs || 3000,
        label: "Use another account"
      });

      await authPage.waitForLoadState("domcontentloaded", {
        timeout: target.timeoutMs
      }).catch(() => {});

      await sleep(login.waitAfterUseAnotherAccountMs || 1000);
    } catch {}
  }

  const email = env(login.usernameEnv || "APP_LOGIN_EMAIL");
  if (!email) throw new Error(`登录邮箱 Secret 为空：${login.usernameEnv || "APP_LOGIN_EMAIL"}`);

  const usernameSelectors = toArray(login.usernameSelectors || login.usernameSelector, [
    "input[type=\"email\"]",
    "input[name=\"identifier\"]",
    "#identifierId"
  ]);

  await fillFirstVisible(authPage, usernameSelectors, email, {
    timeoutMs: target.timeoutMs,
    label: "邮箱输入框"
  });

  const emailNextSelectors = toArray(login.emailNextSelectors || login.nextSelectors || login.nextSelector, [
    "#identifierNext",
    "#identifierNext button",
    "button:has-text(\"Next\")",
    "text=Next",
    "button:has-text(\"下一步\")",
    "text=下一步"
  ]);

  await clickFirstVisible(authPage, emailNextSelectors, {
    timeoutMs: target.timeoutMs,
    label: "邮箱后的下一步按钮"
  });

  if (login.waitAfterNextMs) {
    await sleep(login.waitAfterNextMs);
  } else {
    await sleep(2500);
  }

  await authPage.waitForLoadState("domcontentloaded", {
    timeout: target.timeoutMs
  }).catch(() => {});

  const password = env(login.passwordEnv || "APP_LOGIN_PASSWORD");
  if (!password) throw new Error(`登录密码 Secret 为空：${login.passwordEnv || "APP_LOGIN_PASSWORD"}`);

  const passwordSelectors = toArray(login.passwordSelectors || login.passwordSelector, [
    "input[type=\"password\"]",
    "input[name=\"Passwd\"]"
  ]);

  await fillFirstVisible(authPage, passwordSelectors, password, {
    timeoutMs: target.timeoutMs,
    label: "密码输入框"
  });

  const passwordNextSelectors = toArray(login.passwordNextSelectors || login.submitSelectors || login.submitSelector, [
    "#passwordNext",
    "#passwordNext button",
    "button:has-text(\"Next\")",
    "text=Next",
    "button:has-text(\"下一步\")",
    "text=下一步",
    "button[type=\"submit\"]"
  ]);

  await clickFirstVisible(authPage, passwordNextSelectors, {
    timeoutMs: target.timeoutMs,
    label: "密码后的下一步/登录按钮"
  });

  if (login.waitAfterLoginMs) {
    await sleep(login.waitAfterLoginMs);
  } else {
    await sleep(8000);
  }

  const suspiciousTexts = [
    "Verify it’s you",
    "Verify it's you",
    "2-Step Verification",
    "Enter a verification code",
    "This browser or app may not be secure",
    "Couldn’t sign you in",
    "Couldn't sign you in",
    "Captcha",
    "验证码",
    "两步验证"
  ];

  const authBodyText = await authPage.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  for (const text of suspiciousTexts) {
    if (authBodyText.includes(text)) {
      throw new Error(`Google 登录被安全验证拦截：页面出现 "${text}"`);
    }
  }

  if (authPage !== page) {
    await authPage.waitForEvent("close", {
      timeout: login.popupCloseTimeoutMs || 20000
    }).catch(() => {});
  }

  await page.waitForLoadState("domcontentloaded", {
    timeout: target.timeoutMs
  }).catch(() => {});

  if (target.url) {
    await page.goto(target.url, {
      waitUntil: target.waitUntil || "domcontentloaded",
      timeout: target.timeoutMs
    }).catch(() => {});
  }

  if (login.successSelector) {
    await page.waitForSelector(login.successSelector, {
      timeout: login.successTimeoutMs || target.timeoutMs
    });
  }
}

async function evaluatePage(page, target) {
  const title = await page.title().catch(() => "");
  const currentUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 10000 }).catch(() => "");

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

  for (let attempt = 1; attempt <= target.maxRetries; attempt++) {
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

      const response = await page.goto(target.url, {
        waitUntil: target.waitUntil,
        timeout: target.timeoutMs
      });

      const status = response ? response.status() : null;

      if (target.clickSelector) {
        await page.click(target.clickSelector, { timeout: target.timeoutMs });
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

      if (evaluation.ok) return lastResult;

      lastError = evaluation.reason;
    } catch (error) {
      lastError = `${error.name || "Error"}: ${error.message || String(error)}`;

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

  await sleep(Math.floor(Math.random() * 2500));

  const previousState = readJson(STATE_FILE, { targets: {} });
  const targets = loadTargets();

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox"
    ]
  });

  const results = [];

  for (const target of targets) {
    const result = await checkTarget(browser, target);
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
