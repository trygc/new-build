const { test } = require("@playwright/test");

const target = "https://try-gc-dashboard-jo9d4uu00-trygc-chop.vercel.app";

test("audit deployment render and runtime state", async ({ page }) => {
  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];
  const interestingResponses = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });

  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText,
    });
  });

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/_next/") || url.includes("/api/")) {
      interestingResponses.push({
        status: response.status(),
        url,
      });
    }
  });

  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(3_000);

  const report = {
    url: page.url(),
    title: await page.title(),
    bodyTextLength: (await page.locator("body").innerText()).trim().length,
    bodyText: (await page.locator("body").innerText()).trim().slice(0, 1_000),
    nextRootHtml: await page
      .locator("#__next")
      .evaluate((element) => element.innerHTML.slice(0, 1_000)),
    frameworkOverlayCount: await page
      .locator(
        "[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay",
      )
      .count(),
    consoleMessages,
    pageErrors,
    failedRequests,
    interestingResponses,
  };

  console.log(`DEPLOYMENT_AUDIT_REPORT=${JSON.stringify(report)}`);
});

test("measure first visible auth UI", async ({ page }) => {
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const startedAt = Date.now();
  const result = await page.evaluate(async () => {
    const started = performance.now();
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity) > 0.05
      );
    };

    while (performance.now() - started < 10_000) {
      const heading = [...document.querySelectorAll("h1,h2,h3,button,a,label")]
        .find((element) => element.textContent?.includes("Welcome back"));
      const email = document.querySelector("input[type='email'], input[name*='email' i]");
      if (isVisible(heading) && isVisible(email)) {
        return {
          visibleAfterMs: Math.round(performance.now() - started),
          text: document.body.innerText.trim().slice(0, 500),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return {
      visibleAfterMs: null,
      text: document.body.innerText.trim().slice(0, 500),
    };
  });

  console.log(
    `VISIBLE_AUTH_UI=${JSON.stringify({
      wallClockMs: Date.now() - startedAt,
      ...result,
    })}`,
  );
});

test("exercise auth entry points", async ({ page }) => {
  const interactions = [];
  const consoleMessages = [];
  const failedRequests = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });

  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText,
    });
  });

  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(4_000);

  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(2_000);
  interactions.push({
    action: "empty sign in",
    url: page.url(),
    signUpLinkCount: await page.getByRole("link", { name: /sign up/i }).count(),
    text: (await page.locator("body").innerText()).trim().slice(0, 1_000),
  });

  if ((await page.getByRole("link", { name: /sign up/i }).count()) > 0) {
    await page.getByRole("link", { name: /sign up/i }).click();
  }
  await page.waitForTimeout(1_000);
  interactions.push({
    action: "click sign up",
    url: page.url(),
    signUpLinkCount: await page.getByRole("link", { name: /sign up/i }).count(),
    text: (await page.locator("body").innerText()).trim().slice(0, 1_000),
  });

  console.log(
    `AUTH_INTERACTIONS=${JSON.stringify({
      interactions,
      consoleMessages,
      failedRequests,
    })}`,
  );
});

test("inspect form semantics", async ({ page }) => {
  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(4_000);

  const semantics = await page.evaluate(() => {
    const simplify = (element) => ({
      tag: element.tagName.toLowerCase(),
      text: element.textContent?.trim(),
      role: element.getAttribute("role"),
      href: element.getAttribute("href"),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      id: element.getAttribute("id"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaLabelledby: element.getAttribute("aria-labelledby"),
      required: element.hasAttribute("required"),
      disabled: element.hasAttribute("disabled"),
      tabIndex: element.getAttribute("tabindex"),
      outerHTML: element.outerHTML.slice(0, 500),
    });

    return {
      links: [...document.querySelectorAll("a")].map(simplify),
      buttons: [...document.querySelectorAll("button")].map(simplify),
      inputs: [...document.querySelectorAll("input")].map(simplify),
      labels: [...document.querySelectorAll("label")].map(simplify),
      signUpCandidates: [...document.querySelectorAll("*")]
        .filter((element) => element.textContent?.trim() === "Sign Up")
        .map(simplify),
    };
  });

  console.log(`FORM_SEMANTICS=${JSON.stringify(semantics)}`);
});

test("exercise sign up toggle as rendered button", async ({ page }) => {
  await page.goto(target, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(4_000);

  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForTimeout(500);

  console.log(
    `SIGN_UP_TOGGLE=${JSON.stringify({
      url: page.url(),
      text: (await page.locator("body").innerText()).trim().slice(0, 1_000),
      inputs: await page.locator("input").evaluateAll((inputs) =>
        inputs.map((input) => ({
          type: input.getAttribute("type"),
          autocomplete: input.getAttribute("autocomplete"),
          required: input.hasAttribute("required"),
          placeholder: input.getAttribute("placeholder"),
        })),
      ),
    })}`,
  );
});
