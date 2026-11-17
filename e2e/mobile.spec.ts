/**
 * Mobile web UI (fork): the app must be usable on a phone browser. Runs on
 * Chromium, Firefox and WebKit at phone size (playwright.config.ts).
 */
import { expect, test, type Page } from "@playwright/test";

const CHAT_ID = "chat_mobilee2e_0a1b2c3d";

async function noHorizontalScroll(page: Page) {
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
	expect(scrollWidth, "the page must not scroll sideways").toBeLessThanOrEqual(innerWidth);
}

async function sidebarHidden(page: Page) {
	await expect(page.locator("aside").first()).toHaveAttribute("aria-hidden", "true");
}

async function openDrawer(page: Page) {
	await page.getByRole("button", { name: "Open sidebar" }).first().click();
	const aside = page.locator("aside").first();
	await expect(aside).toHaveAttribute("aria-hidden", "false");
	const box = await aside.boundingBox();
	const width = page.viewportSize()!.width;
	expect(box!.x).toBeGreaterThanOrEqual(-1);
	expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
	return aside;
}

test.describe("phone layout", () => {
	test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, "phone projects only");

	test("home page fits the screen with the sidebar closed", async ({ page }) => {
		await page.goto("/");
		await sidebarHidden(page);
		await noHorizontalScroll(page);
		const composer = page.getByRole("textbox").first();
		await expect(composer).toBeVisible();
		const box = await composer.boundingBox();
		expect(box!.width, "the composer gets most of the width").toBeGreaterThan(page.viewportSize()!.width * 0.6);
	});

	test("the sidebar opens as a drawer and the backdrop closes it", async ({ page }) => {
		await page.goto("/");
		await openDrawer(page);
		await page.getByTestId("sidebar-backdrop").click({ position: { x: page.viewportSize()!.width - 10, y: 300 } });
		await sidebarHidden(page);
	});

	test("opening a chat from the drawer closes it and shows the chat full width", async ({ page }) => {
		await page.goto("/");
		const aside = await openDrawer(page);
		await aside.getByText("Mobile layout check", { exact: false }).click();
		await page.waitForURL(`**/chat/${CHAT_ID}`);
		await sidebarHidden(page);
		const paragraph = page.getByText("Fixed-price contracts move the estimation risk", { exact: false }).first();
		await expect(paragraph).toBeVisible();
		const box = await paragraph.boundingBox();
		expect(box!.width, "chat text uses the screen width").toBeGreaterThan(page.viewportSize()!.width * 0.7);
		await noHorizontalScroll(page);
	});

	test("chat page: model picker stays on one line", async ({ page }) => {
		await page.goto(`/chat/${CHAT_ID}`);
		await noHorizontalScroll(page);
		const pill = page.getByRole("button", { name: /deepseek/i }).first();
		await expect(pill).toBeVisible();
		const box = await pill.boundingBox();
		expect(box!.height, "one line of text").toBeLessThan(40);
		expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
	});

	test("settings open full screen with a tab row", async ({ page }) => {
		await page.goto("/");
		const aside = await openDrawer(page);
		await aside.getByText("Settings", { exact: true }).click();
		const dialog = page.getByTestId("settings-dialog");
		await expect(dialog).toBeVisible();
		const width = page.viewportSize()!.width;
		// The dialog scales in (settings-dialog-pop): measure after the animation.
		await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThanOrEqual(width - 2);
		const nav = page.getByTestId("settings-nav");
		expect(await nav.evaluate((el) => getComputedStyle(el).flexDirection)).toBe("row");
		await page.getByTestId("settings-nav-general").click();
		await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "true");
		await noHorizontalScroll(page);
	});
});

test("@desktop keeps the inline sidebar on a wide screen", async ({ page }) => {
	await page.goto("/");
	const aside = page.locator("aside").first();
	await expect(aside).toHaveAttribute("aria-hidden", "false");
	await expect(page.getByTestId("sidebar-backdrop")).toHaveCount(0);
	expect(await aside.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
});
