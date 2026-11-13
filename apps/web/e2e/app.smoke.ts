// Browser smoke flows: boot, local flow persistence, templates, not found.
// Every test also fails on any app error (see the `appErrors` fixture).
// Each one only touches a local flow in a fresh browser context, so all of them
// also run against the deployed site.
import { canvasNodes, expect, test } from "./fixtures";

// Safe against production: `bun run smoke:live` runs these after a rollout.
const LIVE = { tag: "@live" };

test("the app boots without errors", LIVE, async ({ page }) => {
  await page.goto("/");

  // Signed out, the local flow is the spotlight on the flow list.
  await expect(page.getByRole("button", { name: "Open flow" })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);

  // Let late effects (wasm runtime attach, analytics, auth) settle before the
  // fixture checks for errors.
  await page.waitForLoadState("networkidle");
});

test("a node added to the local flow survives a reload", LIVE, async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open flow" }).click();
  await expect(page).toHaveURL(/\/flow\/local\/graph$/);

  const nodes = canvasNodes(page);
  await expect(page.getByTestId("add-node")).toBeVisible();
  const before = await nodes.count();

  // Not `click()`: Obscura's layout gives the canvas no height, so the dock
  // sits outside the viewport and has no point to click. The handler is the
  // same either way.
  await page.getByTestId("add-node").dispatchEvent("click");
  const search = page.getByRole("dialog").getByRole("combobox");
  await search.fill("Constant");
  await search.press("Enter");
  // The new node follows the pointer until placed; Enter places it where it is.
  await page.keyboard.press("Enter");
  await expect(nodes).toHaveCount(before + 1);

  await page.reload();
  await expect(page.getByTestId("add-node")).toBeVisible();
  await expect(nodes).toHaveCount(before + 1);
});

test("a template loads into the editor", LIVE, async ({ page }) => {
  await page.goto("/templates");

  const card = page.locator('[data-testid="template-card"][data-template-id="blink"]');
  const preview = canvasNodes(card);
  await expect(preview.first()).toBeAttached();
  const expected = await preview.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-id")).sort(),
  );
  expect(expected.length).toBeGreaterThan(0);

  await card.click();
  await expect(page).toHaveURL(/\/flow\/local\/graph$/);

  const nodes = canvasNodes(page);
  await expect(nodes).toHaveCount(expected.length);
  const actual = await nodes.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-id")).sort(),
  );
  expect(actual).toEqual(expected);
});

test("an unknown URL shows the not-found screen", LIVE, async ({ page }) => {
  await page.goto("/this-page-does-not-exist");

  await expect(page.getByText("Page not found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to flows" })).toBeVisible();
});
