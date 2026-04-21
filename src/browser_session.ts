import { connect } from "puppeteer-real-browser";
import { warmGoogleRpcRuntime } from "./google_rpc.ts";

export type Browser = Awaited<ReturnType<typeof connect>>["browser"];
export type Page = Awaited<ReturnType<Browser["pages"]>>[number];

export let browserSession: BrowserSession;

export default class BrowserSession {
	private _browser?: Browser;
	private _page?: Page;
	private _refreshPromise?: Promise<void>;
	private _refreshRequested = false;
	private _activeRequests = 0;
	private _closed = false;
	private _pageSerial = 0;
	private _refreshIntervalId?: number;

	constructor(private refreshIntervalMs: number = 60 * 60 * 1000) {
		browserSession = this;
	}

	public async init() {
		await this._refresh("initial startup");
		this._resetInterval();
	}

	public async withPage<T>(callback: (page: Page) => Promise<T>) {
		await this._ensureReady();

		const page = this._page;
		if (!page) {
			throw new Error("browser session page is not available");
		}

		this._activeRequests += 1;
		try {
			return await callback(page);
		} finally {
			this._activeRequests -= 1;
			this._runDeferredRefreshIfIdle();
		}
	}

	public async withIsolatedPage<T>(callback: (page: Page) => Promise<T>) {
		await this._ensureReady();

		const browser = this._browser;
		if (!browser) {
			throw new Error("browser session browser is not available");
		}

		const page = await browser.newPage();
		const pageId = this._pageSerial++;
		this._activeRequests += 1;
		try {
			await this._setupPage(page, pageId);
			console.log(`page ${pageId} isolated ready`);
			return await callback(page);
		} finally {
			await page.close().catch((error) => {
				console.error(`failed to close isolated page ${pageId}`);
				console.error(error);
			});
			this._activeRequests -= 1;
			this._runDeferredRefreshIfIdle();
		}
	}

	public requestRefresh(reason?: unknown) {
		if (this._closed) {
			return;
		}

		if (reason) {
			console.warn("scheduling browser session refresh");
			console.error(reason);
		}

		if (this._activeRequests > 0 || this._refreshPromise) {
			this._refreshRequested = true;
			return;
		}

		this._refreshInBackground("requested refresh");
	}

	public async close() {
		this._closed = true;
		if (this._refreshIntervalId !== undefined) {
			clearInterval(this._refreshIntervalId);
		}

		if (this._refreshPromise) {
			await this._refreshPromise.catch(() => {});
		}

		await this._closeBrowser(this._browser);
		this._browser = undefined;
		this._page = undefined;
	}

	private async _ensureReady() {
		if (this._refreshPromise) {
			await this._refreshPromise;
		}

		if (this._closed) {
			throw new Error("browser session is closed");
		}

		if (!this._page || this._page.isClosed()) {
			const refreshPromise = this._beginRefresh("page missing or closed");
			if (refreshPromise) {
				await refreshPromise;
			}
		}
	}

	private _resetInterval() {
		this._refreshIntervalId = setInterval(() => {
			if (this._closed) {
				return;
			}
			if (this._refreshPromise) {
				console.log(
					"skipping browser refresh while another refresh is already in progress",
				);
				return;
			}
			if (this._activeRequests > 0) {
				console.log("deferring browser refresh; requests still in flight");
				this._refreshRequested = true;
				return;
			}

			this._refreshInBackground("scheduled refresh");
		}, this.refreshIntervalMs);
	}

	private _runDeferredRefreshIfIdle() {
		if (
			this._closed ||
			this._activeRequests > 0 ||
			!this._refreshRequested ||
			this._refreshPromise
		) {
			return;
		}

		this._refreshRequested = false;
		this._refreshInBackground("deferred refresh");
	}

	private _refreshInBackground(reason: string) {
		void this._beginRefresh(reason)?.catch(() => {});
	}

	private _beginRefresh(reason: string) {
		if (this._closed) {
			return undefined;
		}
		if (this._refreshPromise) {
			return this._refreshPromise;
		}

		this._refreshPromise = this._refresh(reason)
			.catch((error) => {
				console.error("failed to refresh browser session");
				console.error(error);
				throw error;
			})
			.finally(() => {
				this._refreshPromise = undefined;
				this._runDeferredRefreshIfIdle();
			});

		return this._refreshPromise;
	}

	private async _refresh(reason: string) {
		if (this._closed) {
			return;
		}

		console.log(`refreshing browser session (${reason})`);
		const previousBrowser = this._browser;

		const { browser } = await connect({
			headless: false,
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
			],
			customConfig: {},
			turnstile: true,
			connectOption: {},
			disableXvfb: false,
			ignoreAllFlags: false,
		});
		console.log("browser launched");

		try {
			const page = await browser.newPage();
			const pageId = this._pageSerial++;
			await this._setupPage(page, pageId);
			this._browser = browser;
			this._page = page;
			console.log(`page ${pageId} ready`);
		} catch (error) {
			await this._closeBrowser(browser);
			throw error;
		}

		await this._closeBrowser(previousBrowser);
	}

	private async _setupPage(page: Page, index: number) {
		await page.setCacheEnabled(false);
		await page.setRequestInterception(true);
		page.on("request", (req) => {
			if (["image", "stylesheet", "font"].includes(req.resourceType())) {
				req.abort();
			} else {
				req.continue();
			}
		});

		console.log(`page ${index} created`);
		await page.goto("https://translate.google.com/details", {
			waitUntil: "networkidle2",
		});
		console.log(`page ${index} loaded`);

		await this._handlePrivacyConsent(page, index);
		await warmGoogleRpcRuntime(page);
	}

	private async _handlePrivacyConsent(page: Page, index: number) {
		try {
			const btnSelector = 'button[aria-label="Reject all"]';
			await page.waitForSelector(btnSelector, { timeout: 1000 });
			await page.click(btnSelector);
			console.log(`page ${index} privacy consent rejected`);
		} catch {
			console.log(`page ${index} privacy consent not found`);
		}
	}

	private async _closeBrowser(browser?: Browser) {
		if (!browser) {
			return;
		}

		await browser.close().catch((error) => {
			console.error("failed to close browser");
			console.error(error);
		});
	}
}
