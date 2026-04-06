import * as http from "http";
import * as https from "https";
import { promises as fs } from "fs";
import {
    createPublicClient,
    createWalletClient,
    http as viemHttp,
    parseUnits,
    formatUnits,
    getAddress,
    defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
// ---------------------------------------------------------------------------
// MODEL_PRICING (inlined from server/radius.ts)
// ---------------------------------------------------------------------------

type OpenRouterModelPricingSnapshot = {
    pricing: { prompt: string; completion: string };
};

function perTokenUsdToPer1kUsd(perTokenUsd: string): string {
    return (parseFloat(perTokenUsd) * 1000).toFixed(6);
}

const OPENROUTER_PRICING_SNAPSHOT: Record<
    string,
    OpenRouterModelPricingSnapshot
> = {
    "meta-llama/llama-3.3-70b-instruct": {
        pricing: { prompt: "0.0000001", completion: "0.00000032" },
    },
    "meta-llama/llama-4-maverick": {
        pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
    "meta-llama/llama-4-scout": {
        pricing: { prompt: "0.00000008", completion: "0.0000003" },
    },
    "deepseek/deepseek-chat-v3-0324": {
        pricing: { prompt: "0.0000002", completion: "0.00000077" },
    },
    "deepseek/deepseek-r1": {
        pricing: { prompt: "0.0000007", completion: "0.0000025" },
    },
    "anthropic/claude-sonnet-4": {
        pricing: { prompt: "0.000003", completion: "0.000015" },
    },
    "openai/gpt-4o": {
        pricing: { prompt: "0.0000025", completion: "0.00001" },
    },
    "openai/gpt-4o-mini": {
        pricing: { prompt: "0.00000015", completion: "0.0000006" },
    },
    "google/gemini-2.5-pro": {
        pricing: { prompt: "0.00000125", completion: "0.00001" },
    },
    "google/gemini-2.5-flash": {
        pricing: { prompt: "0.0000003", completion: "0.0000025" },
    },
    "qwen/qwen-2.5-72b-instruct": {
        pricing: { prompt: "0.00000012", completion: "0.00000039" },
    },
    "mistralai/mistral-large-2411": {
        pricing: { prompt: "0.000002", completion: "0.000006" },
    },
};

const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
    "google/gemini-2.5-pro-preview": "google/gemini-2.5-pro",
    "google/gemini-2.5-flash-preview": "google/gemini-2.5-flash",
};

const MODEL_PRICING: Record<
    string,
    { promptPer1k: string; completionPer1k: string }
> = (() => {
    const pricing: Record<
        string,
        { promptPer1k: string; completionPer1k: string }
    > = {};

    for (const [modelId, model] of Object.entries(
        OPENROUTER_PRICING_SNAPSHOT,
    )) {
        pricing[modelId] = {
            promptPer1k: perTokenUsdToPer1kUsd(model.pricing.prompt),
            completionPer1k: perTokenUsdToPer1kUsd(model.pricing.completion),
        };
    }

    for (const [alias, canonical] of Object.entries(OPENROUTER_MODEL_ALIASES)) {
        const canonicalPricing = pricing[canonical];
        if (canonicalPricing) {
            pricing[alias] = canonicalPricing;
        }
    }

    return pricing;
})();

// ---------------------------------------------------------------------------

const RADROUTER_URL =
    process.env.RADROUTER_URL || "https://rad-router.eriksreks.workers.dev";
const PORT = parseInt(process.env.RADROUTER_PROXY_PORT || "4020", 10);
const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;
const RADIUS_EXPLORER_URL = "https://network.radiustech.xyz";

const DEFAULT_MODEL_MAP: Record<string, string> = {
    "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
    "claude-sonnet-4-5-20250929": "anthropic/claude-sonnet-4.5",
    "claude-opus-4-5-20251101": "anthropic/claude-opus-4.5",
    haiku: "anthropic/claude-haiku-4.5",
    sonnet: "anthropic/claude-sonnet-4.5",
    opus: "anthropic/claude-opus-4.5",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
};

function loadModelMap(): Record<string, string> {
    const envValue = process.env.RADROUTER_MODEL_MAP;
    if (!envValue) return DEFAULT_MODEL_MAP;

    try {
        const parsed = JSON.parse(envValue);
        if (!parsed || typeof parsed !== "object") {
            return DEFAULT_MODEL_MAP;
        }

        const envMap: Record<string, string> = {};
        for (const [from, to] of Object.entries(parsed)) {
            if (typeof from !== "string" || typeof to !== "string") {
                continue;
            }

            envMap[from.toLowerCase()] = to;
        }

        return {
            ...DEFAULT_MODEL_MAP,
            ...envMap,
        };
    } catch (err: any) {
        console.warn(
            `[proxy] Failed to parse RADROUTER_MODEL_MAP, using defaults: ${err?.message || "unknown error"}`,
        );
        return DEFAULT_MODEL_MAP;
    }
}

const MODEL_MAP = loadModelMap();

function normalizeProxyPaymentScheme(value?: string): "exact" | "upto" {
    return value?.toLowerCase() === "upto" ? "upto" : "exact";
}

const EXPECTED_PAYMENT_SCHEME = normalizeProxyPaymentScheme(
    process.env.RADROUTER_X402_SCHEME,
);

function isValidPrivateKey(value: string): value is `0x${string}` {
    return PRIVATE_KEY_REGEX.test(value);
}

function assertValidPrivateKey(value: string, source: string): `0x${string}` {
    if (!isValidPrivateKey(value)) {
        throw new Error(
            `[proxy] Invalid private key format from ${source}. Expected 0x + 64 hex characters.`,
        );
    }
    return value;
}

async function readPrivateKeyFromFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath, "utf-8");
    return content.trim();
}

async function promptForPrivateKeyHidden(): Promise<string> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            "[proxy] Private key not provided. Set RADROUTER_PROXY_PRIVATE_KEY, RADROUTER_PROXY_PRIVATE_KEY_FILE, or run in an interactive terminal.",
        );
    }

    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        let key = "";

        const cleanup = () => {
            stdin.off("data", onData);
            stdin.off("error", onError);
            if (stdin.isTTY) {
                stdin.setRawMode(false);
            }
            stdin.pause();
        };

        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        const onData = (chunk: string | Buffer) => {
            const input =
                typeof chunk === "string" ? chunk : chunk.toString("utf8");

            for (const ch of input) {
                if (ch === "\r" || ch === "\n") {
                    cleanup();
                    process.stdout.write("\n");
                    resolve(key.trim());
                    return;
                }
                if (ch === "\u0003") {
                    cleanup();
                    process.stdout.write("\n");
                    reject(
                        new Error(
                            "[proxy] Private key entry canceled by user.",
                        ),
                    );
                    return;
                }
                if (ch === "\u0008" || ch === "\u007f") {
                    key = key.slice(0, -1);
                    continue;
                }
                key += ch;
            }
        };

        process.stdout.write("[proxy] Enter private key (input hidden): ");
        stdin.setEncoding("utf8");
        if (stdin.isTTY) {
            stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.on("data", onData);
        stdin.on("error", onError);
    });
}

async function loadPrivateKey(): Promise<`0x${string}`> {
    if (process.env.RADROUTER_PROXY_PRIVATE_KEY) {
        return assertValidPrivateKey(
            process.env.RADROUTER_PROXY_PRIVATE_KEY.trim(),
            "RADROUTER_PROXY_PRIVATE_KEY",
        );
    }

    if (process.env.RADROUTER_PROXY_PRIVATE_KEY_FILE) {
        const fileKey = await readPrivateKeyFromFile(
            process.env.RADROUTER_PROXY_PRIVATE_KEY_FILE,
        );
        return assertValidPrivateKey(
            fileKey,
            "RADROUTER_PROXY_PRIVATE_KEY_FILE",
        );
    }

    if (process.env.RADROUTER_PRIVATE_KEY) {
        console.warn(
            "[proxy] RADROUTER_PRIVATE_KEY is deprecated. Please migrate to RADROUTER_PROXY_PRIVATE_KEY.",
        );
        return assertValidPrivateKey(
            process.env.RADROUTER_PRIVATE_KEY.trim(),
            "RADROUTER_PRIVATE_KEY",
        );
    }

    const promptedKey = await promptForPrivateKeyHidden();
    return assertValidPrivateKey(promptedKey, "interactive prompt");
}

const SBC_TOKEN = "0x33ad9e4bd16b69b5bfded37d8b5d9ff9aba014fb" as const;
const SBC_DECIMALS = 6;

const SBC_PERMIT_TYPES = {
    Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
} as const;

const ERC20_NONCES_ABI = [
    {
        inputs: [{ name: "owner", type: "address" }],
        name: "nonces",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

const radiusMainnet = defineChain({
    id: 723487,
    name: "Radius Network",
    nativeCurrency: { decimals: 18, name: "RUSD", symbol: "RUSD" },
    rpcUrls: { default: { http: ["https://rpc.radiustech.xyz"] } },
    blockExplorers: {
        default: {
            name: "Radius Explorer",
            url: "https://network.radiustech.xyz",
        },
    },
});

const ERC20_BALANCE_OF_ABI = [
    {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

let account!: ReturnType<typeof privateKeyToAccount>;
let publicClient!: ReturnType<typeof createPublicClient>;
let walletClient!: ReturnType<typeof createWalletClient>;

async function initializeSignerAndClients() {
    const privateKey = await loadPrivateKey();
    account = privateKeyToAccount(privateKey);

    publicClient = createPublicClient({
        chain: radiusMainnet,
        transport: viemHttp(),
    });

    walletClient = createWalletClient({
        account,
        chain: radiusMainnet,
        transport: viemHttp(),
    });
}

interface PaymentRequirement {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
}

interface PaymentResponse {
    error: string;
    x402Version: number;
    accepts: PaymentRequirement[];
}

function logSection(title: string) {
    console.log(`\n[rad-router] ${title}`);
}

function logStep(label: string, details: string) {
    console.log(`[x402] ${label.padEnd(18)} ${details}`);
}

function toNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactSensitive(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item));
    }

    if (!isPlainObject(value)) return value;

    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        const lower = k.toLowerCase();
        const shouldRedact =
            lower.includes("authorization") ||
            lower.includes("api-key") ||
            lower.includes("apikey") ||
            lower.includes("token") ||
            lower.includes("secret") ||
            lower.includes("private") ||
            lower === "x-payment";

        if (shouldRedact) {
            redacted[k] = "[REDACTED]";
            continue;
        }

        redacted[k] = redactSensitive(v);
    }

    return redacted;
}

function summarizeMessageContent(content: unknown): Record<string, unknown> {
    if (typeof content === "string") {
        const trimmed = content.trim();
        return {
            shape: "string",
            chars: content.length,
            trimmedChars: trimmed.length,
            isEmptyTrimmed: trimmed.length === 0,
        };
    }

    if (Array.isArray(content)) {
        let textBlocks = 0;
        let emptyTextBlocks = 0;
        let whitespaceTextBlocks = 0;

        const blockTypes: Record<string, number> = {};

        for (const block of content) {
            if (!isPlainObject(block)) {
                blockTypes["non_object"] = (blockTypes["non_object"] || 0) + 1;
                continue;
            }

            const type =
                typeof block.type === "string" ? block.type : "unknown_type";
            blockTypes[type] = (blockTypes[type] || 0) + 1;

            if (
                type === "input_text" ||
                type === "output_text" ||
                typeof block.text === "string"
            ) {
                textBlocks += 1;
                const text =
                    typeof block.text === "string"
                        ? block.text
                        : typeof block.refusal === "string"
                          ? block.refusal
                          : "";
                if (text.length === 0) {
                    emptyTextBlocks += 1;
                } else if (text.trim().length === 0) {
                    whitespaceTextBlocks += 1;
                }
            }
        }

        return {
            shape: "array",
            blocks: content.length,
            textBlocks,
            emptyTextBlocks,
            whitespaceTextBlocks,
            blockTypes,
        };
    }

    if (content === null) {
        return { shape: "null" };
    }

    return { shape: typeof content };
}

function summarizeInputForDiagnostics(input: unknown): Record<string, unknown> {
    if (!Array.isArray(input)) {
        return {
            kind: typeof input,
            isArray: false,
        };
    }

    const summary: Record<string, unknown> = {
        kind: "array",
        isArray: true,
        totalItems: input.length,
        messageItems: 0,
        byRole: {} as Record<string, number>,
        issues: {
            emptyStringContentMessages: 0,
            emptyInputTextBlocks: 0,
            whitespaceInputTextBlocks: 0,
        },
        sample: [] as unknown[],
    };

    const byRole = summary.byRole as Record<string, number>;
    const issues = summary.issues as Record<string, number>;
    const sample = summary.sample as unknown[];

    for (let i = 0; i < input.length; i++) {
        const item = input[i];
        if (!isPlainObject(item)) continue;

        const type = typeof item.type === "string" ? item.type : "unknown";
        const role = typeof item.role === "string" ? item.role : "unknown";

        if (type === "message") {
            summary.messageItems = (summary.messageItems as number) + 1;
            byRole[role] = (byRole[role] || 0) + 1;

            const contentSummary = summarizeMessageContent(item.content);

            if (
                contentSummary.shape === "string" &&
                (contentSummary.isEmptyTrimmed as boolean)
            ) {
                issues.emptyStringContentMessages += 1;
            }

            if (contentSummary.shape === "array") {
                issues.emptyInputTextBlocks +=
                    typeof contentSummary.emptyTextBlocks === "number"
                        ? contentSummary.emptyTextBlocks
                        : 0;
                issues.whitespaceInputTextBlocks +=
                    typeof contentSummary.whitespaceTextBlocks === "number"
                        ? contentSummary.whitespaceTextBlocks
                        : 0;
            }

            if (sample.length < 12) {
                sample.push({
                    index: i,
                    type,
                    role,
                    content: contentSummary,
                });
            }
        }
    }

    return summary;
}

function capturePayloadBoundary(params: {
    stage: "inbound" | "normalized" | "upstream";
    method: string;
    originalPath: string;
    upstreamPath: string;
    isStreamRequest: boolean;
    body: Buffer | null;
    headers?: http.IncomingHttpHeaders | Record<string, string>;
}) {
    const enabled = process.env.RADROUTER_DEBUG_PAYLOAD_CAPTURE === "1";
    if (!enabled) return;

    let parsed: Record<string, unknown> | undefined;
    let parseError: string | undefined;

    if (params.body) {
        try {
            parsed = JSON.parse(params.body.toString("utf-8")) as Record<
                string,
                unknown
            >;
        } catch (err: any) {
            parseError = err?.message || "invalid json";
        }
    }

    const capture = {
        stage: params.stage,
        method: params.method,
        path: params.originalPath,
        upstreamPath: params.upstreamPath,
        stream: params.isStreamRequest,
        bodyBytes: params.body?.length ?? 0,
        parseError,
        model: typeof parsed?.model === "string" ? parsed.model : undefined,
        hasInput: parsed?.input !== undefined,
        inputSummary: summarizeInputForDiagnostics(parsed?.input),
        headers: params.headers ? redactSensitive(params.headers) : undefined,
        body: parsed ? redactSensitive(parsed) : undefined,
    };

    console.log(`[proxy][payload] ${JSON.stringify(capture, null, 2)}`);
}

function parseUsdRate(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function inferPromptTokensFromInput(input: unknown): number {
    if (!Array.isArray(input)) return 0;

    let chars = 0;
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const typedItem = item as Record<string, unknown>;
        const content = typedItem.content;

        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") {
                chars += p.text.length;
            }
        }
    }

    // Approximation: ~4 chars per token.
    return Math.ceil(chars / 4);
}

function computeEstimatedUsageCostSbc(params: {
    model: string;
    input: unknown;
    explicitPromptTokens?: number;
    maxOutputTokens: number;
}): {
    promptTokensEstimate: number;
    completionTokensEstimate: number;
    promptUsd: number;
    completionUsd: number;
    totalUsd: number;
    totalSbcAtomic: bigint;
} {
    const pricing = MODEL_PRICING[params.model] || {
        promptPer1k: "0.001000",
        completionPer1k: "0.002000",
    };

    const promptTokensEstimate = Math.max(
        0,
        params.explicitPromptTokens ?? inferPromptTokensFromInput(params.input),
    );
    const completionTokensEstimate = Math.max(0, params.maxOutputTokens);

    const promptRate = parseUsdRate(pricing.promptPer1k);
    const completionRate = parseUsdRate(pricing.completionPer1k);

    const promptUsd = (promptTokensEstimate / 1000) * promptRate;
    const completionUsd = (completionTokensEstimate / 1000) * completionRate;
    const totalUsd = promptUsd + completionUsd;

    // SBC has 6 decimals; round up to avoid under-collection in estimate.
    const totalSbcAtomic = BigInt(Math.ceil(totalUsd * 1_000_000));

    return {
        promptTokensEstimate,
        completionTokensEstimate,
        promptUsd,
        completionUsd,
        totalUsd,
        totalSbcAtomic,
    };
}

function computeActualUsageCostSbc(params: {
    model: string;
    promptTokens: number;
    completionTokens: number;
}): {
    promptUsd: number;
    completionUsd: number;
    totalUsd: number;
    totalSbcAtomic: bigint;
} {
    const pricing = MODEL_PRICING[params.model] || {
        promptPer1k: "0.001000",
        completionPer1k: "0.002000",
    };

    const promptRate = parseUsdRate(pricing.promptPer1k);
    const completionRate = parseUsdRate(pricing.completionPer1k);

    const promptUsd = (Math.max(0, params.promptTokens) / 1000) * promptRate;
    const completionUsd =
        (Math.max(0, params.completionTokens) / 1000) * completionRate;
    const totalUsd = promptUsd + completionUsd;
    const totalSbcAtomic = BigInt(Math.ceil(totalUsd * 1_000_000));

    return { promptUsd, completionUsd, totalUsd, totalSbcAtomic };
}

function logPricingEstimate(params: {
    model: string;
    normalizedRequestBody: Buffer | null;
    maxOutputTokens: number;
}) {
    if (!params.normalizedRequestBody) return;

    try {
        const payload = JSON.parse(
            params.normalizedRequestBody.toString("utf-8"),
        ) as Record<string, unknown>;

        const estimate = computeEstimatedUsageCostSbc({
            model: params.model,
            input: payload.input,
            explicitPromptTokens:
                typeof payload.prompt_tokens === "number"
                    ? payload.prompt_tokens
                    : undefined,
            maxOutputTokens: params.maxOutputTokens,
        });

        logStep(
            "pricing-est",
            [
                `model=${params.model || "unknown"}`,
                `prompt_est=${estimate.promptTokensEstimate}`,
                `max_out=${estimate.completionTokensEstimate}`,
                `usd=${estimate.totalUsd.toFixed(6)}`,
                `sbc_atomic=${estimate.totalSbcAtomic.toString()}`,
            ].join(" | "),
        );
    } catch {
        // best effort logging only
    }
}

function logActualUsageCost(params: {
    model: string;
    responseBody: Buffer;
    authorizedMaxAmount?: string;
}) {
    try {
        const parsed = JSON.parse(
            params.responseBody.toString("utf-8"),
        ) as Record<string, unknown>;
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (!usage) return;

        const promptTokens =
            toNumber(usage.input_tokens) || toNumber(usage.prompt_tokens);
        const completionTokens =
            toNumber(usage.output_tokens) || toNumber(usage.completion_tokens);

        const actual = computeActualUsageCostSbc({
            model: params.model,
            promptTokens,
            completionTokens,
        });

        let capDetail = "cap=unknown";
        if (params.authorizedMaxAmount) {
            const capAtomic = BigInt(
                Math.max(
                    0,
                    Math.ceil(Number(params.authorizedMaxAmount) * 1_000_000),
                ),
            );
            const clamped =
                actual.totalSbcAtomic > capAtomic
                    ? capAtomic
                    : actual.totalSbcAtomic;
            capDetail = `cap_atomic=${capAtomic.toString()} | actual_clamped_atomic=${clamped.toString()}`;
        }

        logStep(
            "pricing-actual",
            [
                `model=${params.model || "unknown"}`,
                `prompt=${promptTokens}`,
                `completion=${completionTokens}`,
                `usd=${actual.totalUsd.toFixed(6)}`,
                `actual_atomic=${actual.totalSbcAtomic.toString()}`,
                capDetail,
            ].join(" | "),
        );
    } catch {
        // best effort logging only
    }
}

function headerFirst(
    headers: http.IncomingHttpHeaders,
    name: string,
): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
}

function asTxHash(value: string | undefined): string | null {
    if (!value) return null;
    const txHash = value.trim();
    return /^0x[a-fA-F0-9]{64}$/.test(txHash) ? txHash : null;
}

function extractPaymentHeaders(headers: http.IncomingHttpHeaders): {
    verified?: string;
    payer?: string;
    tx?: string;
    txState?: string;
} {
    return {
        verified: headerFirst(headers, "x-payment-verified"),
        payer: headerFirst(headers, "x-payment-payer"),
        tx:
            headerFirst(headers, "x-payment-transaction-hash") ??
            headerFirst(headers, "x-payment-transaction"),
        txState: headerFirst(headers, "x-payment-transaction"),
    };
}

function logTxDetails(txLike?: string, pendingValue?: string) {
    const txHash = asTxHash(txLike);
    if (txHash) {
        logStep("tx", `${txHash}`);
        logStep("explorer", `${RADIUS_EXPLORER_URL}/tx/${txHash}`);
        return;
    }

    const pending = pendingValue ?? txLike;
    if (pending) {
        logStep("tx", `${pending} (awaiting transaction hash)`);
    }
}

function logStreamBodyPreview(responseBody: Buffer) {
    const upstreamBody = responseBody.toString("utf-8").trim();

    if (upstreamBody) {
        const preview =
            upstreamBody.length > 2000
                ? `${upstreamBody.slice(0, 2000)}...`
                : upstreamBody;
        logStep("stream-body", preview);
    } else {
        logStep("stream-body", "No response body captured from upstream.");
    }
}

async function fetchNonce(): Promise<bigint> {
    try {
        const nonce = await (publicClient as any).readContract({
            address: SBC_TOKEN,
            abi: ERC20_NONCES_ABI,
            functionName: "nonces",
            args: [account.address],
        });
        return nonce;
    } catch (err: any) {
        console.warn(
            "[x402] Could not fetch on-chain nonce, using 0:",
            err.message,
        );
        return BigInt(0);
    }
}

async function fetchStartupBalances(): Promise<{
    rusd: bigint;
    sbc: bigint;
}> {
    const [rusd, sbc] = await Promise.all([
        publicClient.getBalance({ address: account.address }),
        (publicClient as any).readContract({
            address: SBC_TOKEN,
            abi: ERC20_BALANCE_OF_ABI,
            functionName: "balanceOf",
            args: [account.address],
        }) as Promise<bigint>,
    ]);

    return { rusd, sbc };
}

function validateCsrfProtection(
    req: http.IncomingMessage,
): { ok: true } | { ok: false; reason: string } {
    const origin = req.headers["origin"];
    const referer = req.headers["referer"];
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];

    // Browsers always send Origin on cross-origin requests.
    // CLI/IDE clients typically omit it, so absent Origin is allowed.
    if (origin && !allowed.some((a) => origin === a)) {
        return { ok: false, reason: "Forbidden cross-origin request" };
    }
    if (referer) {
        try {
            const refOrigin = new URL(referer).origin;
            if (!allowed.some((a) => refOrigin === a)) {
                return { ok: false, reason: "Forbidden cross-origin request" };
            }
        } catch {
            return { ok: false, reason: "Invalid Referer header" };
        }
    }

    return { ok: true };
}

function validateRequirement(requirement: PaymentRequirement): string | null {
    if (requirement.scheme !== EXPECTED_PAYMENT_SCHEME) {
        return `Unsupported scheme: ${requirement.scheme}. Expected ${EXPECTED_PAYMENT_SCHEME}`;
    }
    if (requirement.network !== "radius") {
        return `Wrong network: ${requirement.network}`;
    }
    if (
        requirement.asset &&
        requirement.asset.toLowerCase() !== SBC_TOKEN.toLowerCase()
    ) {
        return `Unsupported asset: ${requirement.asset}`;
    }
    if (!requirement.payTo || !/^0x[a-fA-F0-9]{40}$/.test(requirement.payTo)) {
        return `Invalid payTo address: ${requirement.payTo}`;
    }
    return null;
}

async function signPermit(requirement: PaymentRequirement): Promise<string> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const value = parseUnits(requirement.maxAmountRequired, SBC_DECIMALS);
    const nonce = await fetchNonce();

    const domain = {
        name: "Stable Coin" as const,
        version: "1" as const,
        chainId: 723487,
        verifyingContract: SBC_TOKEN as `0x${string}`,
    };

    const message = {
        owner: account.address,
        spender: getAddress(requirement.payTo) as `0x${string}`,
        value,
        nonce,
        deadline,
    };

    const signature = await walletClient.signTypedData({
        account,
        domain,
        types: SBC_PERMIT_TYPES,
        primaryType: "Permit",
        message,
    });

    const r = `0x${signature.slice(2, 66)}`;
    const s = `0x${signature.slice(66, 130)}`;
    const v = parseInt(signature.slice(130, 132), 16);

    const payload = {
        x402Version: 1,
        scheme: EXPECTED_PAYMENT_SCHEME,
        network: "radius",
        payload: {
            kind: "permit-eip2612",
            owner: account.address,
            spender: requirement.payTo,
            value: value.toString(),
            nonce: nonce.toString(),
            deadline: deadline.toString(),
            v,
            r,
            s,
        },
    };

    return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function normalizeUpstreamPath(path: string): string {
    const pathOnly = path.split("?")[0] || "/";

    // Accept legacy OpenAI Chat Completions client paths (e.g. Zed) and
    // forward them to the Responses endpoint.
    if (pathOnly.endsWith("/chat/completions")) {
        return path.replace(/\/chat\/completions$/, "/responses");
    }

    // Accept Anthropic-style Messages API paths (used by Claude Code) and
    // forward them to the Responses endpoint.
    if (pathOnly.endsWith("/messages")) {
        return path.replace(/\/messages(?=\?|$)/, "/responses");
    }

    return path;
}

function isAnthropicMessagesPath(path: string): boolean {
    const pathOnly = path.split("?")[0] || "/";
    return pathOnly.endsWith("/messages");
}

function isChatCompletionsPath(path: string): boolean {
    const pathOnly = path.split("?")[0] || "/";
    return pathOnly.endsWith("/chat/completions");
}

const DEFAULT_TOOL_PARAMETERS_SCHEMA = {
    type: "object",
    properties: {},
    additionalProperties: true,
} as const;

function normalizeAnthropicToolsToResponses(tools: unknown): unknown {
    if (!Array.isArray(tools)) return tools;

    return tools
        .map((tool) => {
            if (!tool || typeof tool !== "object") return null;
            const t = tool as Record<string, unknown>;
            if (typeof t.name !== "string") return null;

            return {
                type: "function",
                name: t.name,
                ...(typeof t.description === "string"
                    ? { description: t.description }
                    : {}),
                parameters:
                    t.input_schema && typeof t.input_schema === "object"
                        ? t.input_schema
                        : DEFAULT_TOOL_PARAMETERS_SCHEMA,
            };
        })
        .filter((tool) => tool !== null);
}

function mapRequestedModel(model: unknown): unknown {
    if (typeof model !== "string") return model;
    const mapped = MODEL_MAP[model.toLowerCase()];
    return mapped || model;
}

function normalizeChatToolsToResponses(tools: unknown): unknown {
    if (!Array.isArray(tools)) return tools;

    return tools
        .map((tool) => {
            if (!tool || typeof tool !== "object") return null;

            const t = tool as Record<string, unknown>;
            const fn =
                t.function && typeof t.function === "object"
                    ? (t.function as Record<string, unknown>)
                    : null;

            const name =
                typeof t.name === "string"
                    ? t.name
                    : typeof fn?.name === "string"
                      ? fn.name
                      : undefined;
            const description =
                typeof t.description === "string"
                    ? t.description
                    : typeof fn?.description === "string"
                      ? fn.description
                      : undefined;
            const parameters =
                t.parameters && typeof t.parameters === "object"
                    ? t.parameters
                    : t.input_schema && typeof t.input_schema === "object"
                      ? t.input_schema
                      : fn?.parameters && typeof fn.parameters === "object"
                        ? fn.parameters
                        : fn?.input_schema &&
                            typeof fn.input_schema === "object"
                          ? fn.input_schema
                          : undefined;
            const strict =
                typeof t.strict === "boolean"
                    ? t.strict
                    : typeof fn?.strict === "boolean"
                      ? fn.strict
                      : undefined;

            if (
                typeof t.type === "string" &&
                (t.type.startsWith("openrouter:") ||
                    t.type === "web_search" ||
                    t.type === "web_search_preview")
            ) {
                return t;
            }

            if (!name) return null;

            return {
                type: "function",
                name,
                ...(description ? { description } : {}),
                ...(strict !== undefined ? { strict } : {}),
                parameters: parameters ?? DEFAULT_TOOL_PARAMETERS_SCHEMA,
            };
        })
        .filter((tool) => tool !== null);
}

function normalizeChatMessageContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (content === null || content === undefined) return "";

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (!part || typeof part !== "object") return "";

                const p = part as Record<string, unknown>;
                if (typeof p.text === "string") return p.text;
                if (typeof p.refusal === "string") return p.refusal;

                return "";
            })
            .filter((part) => part.length > 0)
            .join("");
    }

    return JSON.stringify(content);
}

function normalizeChatMessagesToResponsesInput(messages: unknown): unknown {
    if (!Array.isArray(messages)) return messages;

    const items: unknown[] = [];

    for (const msg of messages) {
        if (!msg || typeof msg !== "object") {
            items.push(msg);
            continue;
        }

        const m = msg as Record<string, unknown>;
        const role = typeof m.role === "string" ? m.role : undefined;

        // Anthropic messages format:
        // { role: "assistant"|"user", content: [{type:"text"...}|{type:"tool_use"...}|{type:"tool_result"...}] }
        if (Array.isArray(m.content)) {
            const contentParts = m.content as Array<Record<string, unknown>>;

            if (role === "assistant") {
                let assistantText = "";
                for (const part of contentParts) {
                    if (!part || typeof part !== "object") continue;

                    const type = typeof part.type === "string" ? part.type : "";
                    if (type === "text") {
                        const text =
                            typeof part.text === "string" ? part.text : "";
                        assistantText += text;
                    } else if (type === "tool_use") {
                        const callId =
                            (typeof part.id === "string" && part.id) ||
                            (typeof part.tool_use_id === "string" &&
                                part.tool_use_id) ||
                            undefined;
                        const name =
                            typeof part.name === "string"
                                ? part.name
                                : undefined;
                        const input = part.input;

                        if (!callId || !name) continue;

                        items.push({
                            type: "function_call",
                            call_id: callId,
                            name,
                            arguments:
                                typeof input === "string"
                                    ? input
                                    : JSON.stringify(input ?? {}),
                        });
                    }
                }

                if (assistantText.trim().length > 0) {
                    items.push({
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: assistantText }],
                    });
                }
                continue;
            }

            if (role === "user") {
                const userTextParts: string[] = [];

                for (const part of contentParts) {
                    if (!part || typeof part !== "object") continue;

                    const type = typeof part.type === "string" ? part.type : "";

                    if (type === "text") {
                        const text =
                            typeof part.text === "string" ? part.text : "";
                        if (text.trim().length > 0) {
                            userTextParts.push(text);
                        }
                        continue;
                    }

                    if (type === "tool_result") {
                        const callId =
                            (typeof part.tool_use_id === "string" &&
                                part.tool_use_id) ||
                            (typeof part.call_id === "string" &&
                                part.call_id) ||
                            undefined;

                        if (!callId) continue;

                        const content = part.content;
                        const output =
                            typeof content === "string"
                                ? content
                                : Array.isArray(content)
                                  ? content
                                        .map((c) => {
                                            if (typeof c === "string") return c;
                                            if (
                                                c &&
                                                typeof c === "object" &&
                                                typeof (
                                                    c as Record<string, unknown>
                                                ).text === "string"
                                            ) {
                                                return (
                                                    c as Record<string, unknown>
                                                ).text as string;
                                            }
                                            return "";
                                        })
                                        .join("")
                                  : JSON.stringify(content ?? "");

                        if (output.trim().length > 0) {
                            items.push({
                                type: "function_call_output",
                                call_id: callId,
                                output,
                            });
                        }
                    }
                }

                const userText = userTextParts.join("");
                if (userText.trim().length > 0) {
                    items.push({
                        type: "message",
                        role: "user",
                        content: [{ type: "input_text", text: userText }],
                    });
                }

                continue;
            }
        }

        // Handle assistant tool-calls from chat format.
        // chat: { role:"assistant", tool_calls:[{id,type:"function",function:{name,arguments}}], content:null }
        if (role === "assistant" && Array.isArray(m.tool_calls)) {
            const assistantText = normalizeChatMessageContentToText(m.content);
            if (assistantText) {
                items.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: assistantText }],
                });
            }

            const toolCalls = m.tool_calls as Array<Record<string, unknown>>;
            for (const tc of toolCalls) {
                const fn =
                    tc.function && typeof tc.function === "object"
                        ? (tc.function as Record<string, unknown>)
                        : null;
                const name = typeof fn?.name === "string" ? fn.name : undefined;
                const args = fn?.arguments;
                const callId =
                    (typeof tc.id === "string" && tc.id) ||
                    (typeof tc.call_id === "string" && tc.call_id) ||
                    undefined;

                if (!name || !callId) continue;

                items.push({
                    type: "function_call",
                    call_id: callId,
                    name,
                    arguments:
                        typeof args === "string"
                            ? args
                            : JSON.stringify(args ?? {}),
                });
            }

            continue;
        }

        // Handle tool role outputs from chat format.
        // chat: { role:"tool", tool_call_id:"...", content:"..." }
        if (role === "tool") {
            const callId =
                typeof m.tool_call_id === "string"
                    ? m.tool_call_id
                    : typeof m.call_id === "string"
                      ? m.call_id
                      : undefined;

            if (callId) {
                const output = normalizeChatMessageContentToText(m.content);
                if (output.trim().length > 0) {
                    items.push({
                        type: "function_call_output",
                        call_id: callId,
                        output,
                    });
                }
                continue;
            }
        }

        if (role === "assistant") {
            const assistantText = normalizeChatMessageContentToText(m.content);
            if (assistantText) {
                items.push({
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: assistantText }],
                });
            }
            continue;
        }

        if (role === "user" || role === "system" || role === "developer") {
            items.push({
                type: "message",
                role,
                content: [
                    {
                        type: "input_text",
                        text: normalizeChatMessageContentToText(m.content),
                    },
                ],
            });
            continue;
        }

        if (role === "function") {
            const output = normalizeChatMessageContentToText(m.content);
            if (output.trim().length > 0) {
                items.push({
                    type: "function_call_output",
                    call_id:
                        typeof m.name === "string"
                            ? m.name
                            : `function_${items.length}`,
                    output,
                });
            }
            continue;
        }

        items.push(m);
    }

    return sanitizeResponsesInputItems(items);
}

function sanitizeResponsesInputItems(input: unknown): unknown {
    if (!Array.isArray(input)) return input;

    const sanitized: unknown[] = [];

    for (const item of input) {
        if (!item || typeof item !== "object") {
            sanitized.push(item);
            continue;
        }

        const typedItem = item as Record<string, unknown>;
        if (typedItem.type === "function_call_output") {
            const output = typedItem.output;
            if (typeof output === "string" && output.trim().length === 0) {
                continue;
            }
            sanitized.push(typedItem);
            continue;
        }

        if (typedItem.type !== "message") {
            sanitized.push(typedItem);
            continue;
        }

        const content = typedItem.content;

        // String content: drop message if empty/whitespace-only
        if (typeof content === "string") {
            if (content.trim().length === 0) continue;
            sanitized.push(typedItem);
            continue;
        }

        // Non-array content: keep unchanged (best-effort pass-through)
        if (!Array.isArray(content)) {
            sanitized.push(typedItem);
            continue;
        }

        // Array content: remove empty text blocks
        const nextContent = content.filter((part) => {
            if (!part || typeof part !== "object") return true;
            const p = part as Record<string, unknown>;
            const type = typeof p.type === "string" ? p.type : "";

            if (
                type === "input_text" ||
                type === "output_text" ||
                typeof p.text === "string"
            ) {
                const text = typeof p.text === "string" ? p.text : "";
                return text.trim().length > 0;
            }

            return true;
        });

        // Drop message if all content was removed
        if (nextContent.length === 0) continue;

        sanitized.push({
            ...typedItem,
            content: nextContent,
        });
    }

    return sanitized;
}

// ---------------------------------------------------------------------------
// SSE frame helpers shared by both stream translators
// ---------------------------------------------------------------------------

/**
 * Parse a complete SSE frame (content between two blank lines) into an event
 * type and a JSON payload. The worker emits proper SSE with the event type in
 * the `event:` field and the payload object in the `data:` field, e.g.:
 *
 *   event: response.output_text.delta
 *   data: {"response_id":"...","delta":"Hello"}
 *
 * Unlike OpenRouter's native format (which puts `type` inside the JSON),
 * we must read `eventType` from the SSE field, not from the JSON body.
 */
function parseSseFrameProxy(rawFrame: string): {
    eventType?: string;
    payload?: Record<string, unknown>;
} {
    let eventType: string | undefined;
    const dataLines: string[] = [];

    for (const line of rawFrame.split("\n")) {
        if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (dataLines.length === 0) return { eventType };
    const dataStr = dataLines.join("\n");
    if (!dataStr || dataStr === "[DONE]") return { eventType };

    try {
        const payload = JSON.parse(dataStr) as Record<string, unknown>;
        return { eventType, payload };
    } catch {
        return { eventType };
    }
}

/** Emit a single outbound SSE event with both `event:` and `data:` fields. */
function sseEvent(eventName: string, data: unknown): string {
    return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------

interface LegacyChatStreamState {
    id: string;
    model: string;
    created: number;
    firstChunkSent: boolean;
    hasToolCalls: boolean;
    outputIndexToToolIndex: Map<number, number>;
    nextToolIndex: number;
    completed: boolean;
    inputTokens: number;
    outputTokens: number;
}

function legacyChatStreamChunk(
    state: LegacyChatStreamState,
    choices: unknown[],
): string {
    return `data: ${JSON.stringify({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices,
    })}\n\n`;
}

/**
 * Translate one complete SSE frame from the worker's Responses-API format
 * into an OpenAI Chat-Completions streaming chunk (or empty string to skip).
 *
 * The worker places the event type in the SSE `event:` field and the payload
 * in the `data:` JSON — so we use parseSseFrameProxy instead of reading
 * `event.type` from the data body (which is what the old line-based version
 * incorrectly tried to do).
 */
function translateResponsesFrameToChat(
    rawFrame: string,
    state: LegacyChatStreamState,
): string {
    const { eventType, payload } = parseSseFrameProxy(rawFrame);
    if (!eventType || !payload) return "";

    let out = "";

    // Capture model from the initial response.start event.
    if (eventType === "response.start") {
        if (typeof payload.model === "string") state.model = payload.model;
        return "";
    }

    // Emit the role-bearing first chunk before any content.
    if (
        !state.firstChunkSent &&
        (eventType === "response.output_text.delta" ||
            (eventType === "response.raw" &&
                (payload.upstream_type === "response.output_item.added" ||
                    payload.upstream_type === "response.output_text.delta")))
    ) {
        state.firstChunkSent = true;
        out += legacyChatStreamChunk(state, [
            {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
            },
        ]);
    }

    if (eventType === "response.output_text.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        out += legacyChatStreamChunk(state, [
            { index: 0, delta: { content: delta }, finish_reason: null },
        ]);
        return out;
    }

    // Tool call events can arrive either as direct Responses events
    // (response.output_item.added / response.function_call_arguments.delta)
    // or wrapped inside response.raw passthrough.
    if (
        eventType === "response.output_item.added" ||
        eventType === "response.function_call_arguments.delta"
    ) {
        const event = payload;
        if (eventType === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const outputIndex =
                    typeof event.output_index === "number"
                        ? event.output_index
                        : 0;
                const toolIndex = state.nextToolIndex++;
                state.outputIndexToToolIndex.set(outputIndex, toolIndex);
                state.hasToolCalls = true;

                out += legacyChatStreamChunk(state, [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: toolIndex,
                                    id:
                                        (item.call_id as string) ||
                                        (item.id as string) ||
                                        `call_${Math.random().toString(36).slice(2, 10)}`,
                                    type: "function",
                                    function: {
                                        name: (item.name as string) || "",
                                        arguments: "",
                                    },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ]);
            }
            return out;
        }

        const outputIndex =
            typeof event.output_index === "number" ? event.output_index : 0;
        const toolIndex = state.outputIndexToToolIndex.get(outputIndex) ?? 0;
        const delta = typeof event.delta === "string" ? event.delta : "";

        out += legacyChatStreamChunk(state, [
            {
                index: 0,
                delta: {
                    tool_calls: [
                        {
                            index: toolIndex,
                            function: { arguments: delta },
                        },
                    ],
                },
                finish_reason: null,
            },
        ]);
        return out;
    }

    if (eventType === "response.raw") {
        const upstreamType = payload.upstream_type as string | undefined;
        const event = payload.event as Record<string, unknown> | undefined;
        if (!event) return "";

        if (upstreamType === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const outputIndex =
                    typeof event.output_index === "number"
                        ? event.output_index
                        : 0;
                const toolIndex = state.nextToolIndex++;
                state.outputIndexToToolIndex.set(outputIndex, toolIndex);
                state.hasToolCalls = true;

                out += legacyChatStreamChunk(state, [
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: toolIndex,
                                    id:
                                        (item.call_id as string) ||
                                        (item.id as string) ||
                                        `call_${Math.random().toString(36).slice(2, 10)}`,
                                    type: "function",
                                    function: {
                                        name: (item.name as string) || "",
                                        arguments: "",
                                    },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ]);
            }
            return out;
        }

        if (upstreamType === "response.function_call_arguments.delta") {
            const outputIndex =
                typeof event.output_index === "number" ? event.output_index : 0;
            const toolIndex =
                state.outputIndexToToolIndex.get(outputIndex) ?? 0;
            const delta = typeof event.delta === "string" ? event.delta : "";

            out += legacyChatStreamChunk(state, [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: toolIndex,
                                function: { arguments: delta },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ]);
            return out;
        }

        return "";
    }

    if (eventType === "response.completed") {
        state.completed = true;

        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
            if (typeof usage.input_tokens === "number")
                state.inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
                state.outputTokens = usage.output_tokens;
        }

        out += legacyChatStreamChunk(state, [
            {
                index: 0,
                delta: {},
                finish_reason: state.hasToolCalls ? "tool_calls" : "stop",
            },
        ]);
        out += "data: [DONE]\n\n";
        return out;
    }

    return "";
}

// ---------------------------------------------------------------------------
// Anthropic Messages API stream translator
// ---------------------------------------------------------------------------

interface AnthropicMessagesStreamState {
    id: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    hasStarted: boolean;
    hasTextBlock: boolean;
    textBlockIndex: number;
    hasToolCalls: boolean;
    outputIndexToContentIndex: Map<number, number>;
    nextContentIndex: number;
    completed: boolean;
}

/**
 * Translate one complete SSE frame from the worker's Responses-API format
 * into an Anthropic Messages-API streaming event (or empty string to skip).
 *
 * Mapping:
 *   response.start                              → message_start
 *   response.output_text.delta                 → content_block_start (once) + content_block_delta
 *   response.raw / response.output_item.added  → content_block_start (tool_use)
 *   response.raw / response.function_call_arguments.delta → content_block_delta (input_json_delta)
 *   response.raw / response.output_item.done   → content_block_stop
 *   response.completed                         → content_block_stop + message_delta + message_stop
 */
function translateResponsesFrameToMessages(
    rawFrame: string,
    state: AnthropicMessagesStreamState,
): string {
    const { eventType, payload } = parseSseFrameProxy(rawFrame);
    if (!eventType || !payload) return "";

    let out = "";

    if (eventType === "response.start" && !state.hasStarted) {
        state.hasStarted = true;
        if (typeof payload.model === "string") state.model = payload.model;
        // Strip provider prefix: "anthropic/claude-haiku-4.5" → "claude-haiku-4.5"
        const modelDisplay = state.model.includes("/")
            ? state.model.split("/").slice(1).join("/")
            : state.model;

        out += sseEvent("message_start", {
            type: "message_start",
            message: {
                id: state.id,
                type: "message",
                role: "assistant",
                content: [],
                model: modelDisplay,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: state.inputTokens, output_tokens: 0 },
            },
        });
        return out;
    }

    if (eventType === "response.output_text.delta") {
        const delta = typeof payload.delta === "string" ? payload.delta : "";

        if (!state.hasTextBlock) {
            state.hasTextBlock = true;
            state.textBlockIndex = state.nextContentIndex++;
            out += sseEvent("content_block_start", {
                type: "content_block_start",
                index: state.textBlockIndex,
                content_block: { type: "text", text: "" },
            });
        }

        out += sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.textBlockIndex,
            delta: { type: "text_delta", text: delta },
        });
        return out;
    }

    // Tool call events can arrive either as direct Responses events
    // or wrapped inside response.raw passthrough from the worker.
    if (
        eventType === "response.output_item.added" ||
        eventType === "response.function_call_arguments.delta" ||
        eventType === "response.output_item.done"
    ) {
        const event = payload;

        if (eventType === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const outputIndex =
                    typeof event.output_index === "number"
                        ? event.output_index
                        : 0;
                const contentIndex = state.nextContentIndex++;
                state.outputIndexToContentIndex.set(outputIndex, contentIndex);
                state.hasToolCalls = true;

                out += sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: {
                        type: "tool_use",
                        id:
                            (item.call_id as string) ||
                            (item.id as string) ||
                            `toolu_${Math.random().toString(36).slice(2, 10)}`,
                        name: (item.name as string) || "",
                        input: {},
                    },
                });
            }
            return out;
        }

        if (eventType === "response.function_call_arguments.delta") {
            const outputIndex =
                typeof event.output_index === "number" ? event.output_index : 0;
            const contentIndex =
                state.outputIndexToContentIndex.get(outputIndex) ?? 0;
            const delta = typeof event.delta === "string" ? event.delta : "";

            out += sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "input_json_delta", partial_json: delta },
            });
            return out;
        }

        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const outputIndex =
                typeof event.output_index === "number" ? event.output_index : 0;
            const contentIndex =
                state.outputIndexToContentIndex.get(outputIndex);
            if (contentIndex !== undefined) {
                out += sseEvent("content_block_stop", {
                    type: "content_block_stop",
                    index: contentIndex,
                });
            }
        }
        return out;
    }

    if (eventType === "response.raw") {
        const upstreamType = payload.upstream_type as string | undefined;
        const event = payload.event as Record<string, unknown> | undefined;
        if (!event) return "";

        if (upstreamType === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const outputIndex =
                    typeof event.output_index === "number"
                        ? event.output_index
                        : 0;
                const contentIndex = state.nextContentIndex++;
                state.outputIndexToContentIndex.set(outputIndex, contentIndex);
                state.hasToolCalls = true;

                out += sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: {
                        type: "tool_use",
                        id:
                            (item.call_id as string) ||
                            (item.id as string) ||
                            `toolu_${Math.random().toString(36).slice(2, 10)}`,
                        name: (item.name as string) || "",
                        input: {},
                    },
                });
            }
            return out;
        }

        if (upstreamType === "response.function_call_arguments.delta") {
            const outputIndex =
                typeof event.output_index === "number" ? event.output_index : 0;
            const contentIndex =
                state.outputIndexToContentIndex.get(outputIndex) ?? 0;
            const delta = typeof event.delta === "string" ? event.delta : "";

            out += sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "input_json_delta", partial_json: delta },
            });
            return out;
        }

        if (upstreamType === "response.output_item.done") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const outputIndex =
                    typeof event.output_index === "number"
                        ? event.output_index
                        : 0;
                const contentIndex =
                    state.outputIndexToContentIndex.get(outputIndex);
                if (contentIndex !== undefined) {
                    out += sseEvent("content_block_stop", {
                        type: "content_block_stop",
                        index: contentIndex,
                    });
                }
            }
            return out;
        }

        return "";
    }

    if (eventType === "response.completed") {
        state.completed = true;

        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
            if (typeof usage.input_tokens === "number")
                state.inputTokens = usage.input_tokens;
            if (typeof usage.output_tokens === "number")
                state.outputTokens = usage.output_tokens;
        }

        const finishReason =
            typeof payload.finish_reason === "string"
                ? payload.finish_reason
                : "stop";
        const stopReason =
            finishReason === "tool_calls"
                ? "tool_use"
                : finishReason === "length"
                  ? "max_tokens"
                  : "end_turn";

        if (state.hasTextBlock) {
            out += sseEvent("content_block_stop", {
                type: "content_block_stop",
                index: state.textBlockIndex,
            });
        }

        out += sseEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: state.outputTokens },
        });

        out += sseEvent("message_stop", { type: "message_stop" });

        return out;
    }

    return "";
}

function extractResponsesText(response: Record<string, unknown>): string {
    if (typeof response.output_text === "string") return response.output_text;

    const output = response.output;
    if (!Array.isArray(output)) return "";

    const parts: string[] = [];
    for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const i = item as Record<string, unknown>;

        if (typeof i.text === "string") {
            parts.push(i.text);
        }

        if (Array.isArray(i.content)) {
            for (const contentItem of i.content) {
                if (!contentItem || typeof contentItem !== "object") continue;
                const c = contentItem as Record<string, unknown>;
                if (typeof c.text === "string") {
                    parts.push(c.text);
                } else if (typeof c.refusal === "string") {
                    parts.push(c.refusal);
                }
            }
        }
    }

    return parts.join("");
}

function extractResponsesToolCalls(
    response: Record<string, unknown>,
): unknown[] | undefined {
    const output = response.output;
    if (!Array.isArray(output)) return undefined;

    const calls: unknown[] = [];
    for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const i = item as Record<string, unknown>;
        if (i.type !== "function_call") continue;

        calls.push({
            id:
                (i.call_id as string) ||
                (i.id as string) ||
                `call_${Math.random().toString(36).slice(2, 10)}`,
            type: "function",
            function: {
                name: (i.name as string) || "",
                arguments:
                    typeof i.arguments === "string"
                        ? i.arguments
                        : JSON.stringify(i.arguments ?? {}),
            },
        });
    }

    return calls.length > 0 ? calls : undefined;
}

function shapeResponsesAsChatCompletion(
    response: Record<string, unknown>,
    fallbackModel: string,
): Record<string, unknown> {
    const text = extractResponsesText(response);
    const toolCalls = extractResponsesToolCalls(response);

    const message: Record<string, unknown> = { role: "assistant" };
    if (toolCalls) {
        message.content = null;
        message.tool_calls = toolCalls;
    } else {
        message.content = text;
    }

    const usage = response.usage as Record<string, unknown> | undefined;
    const promptTokens =
        typeof usage?.input_tokens === "number"
            ? usage.input_tokens
            : typeof usage?.prompt_tokens === "number"
              ? usage.prompt_tokens
              : 0;
    const completionTokens =
        typeof usage?.output_tokens === "number"
            ? usage.output_tokens
            : typeof usage?.completion_tokens === "number"
              ? usage.completion_tokens
              : 0;

    return {
        id:
            (typeof response.id === "string" && response.id) ||
            `chatcmpl_${Math.random().toString(36).slice(2, 14)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model:
            (typeof response.model === "string" && response.model) ||
            fallbackModel,
        choices: [
            {
                index: 0,
                message,
                finish_reason: toolCalls ? "tool_calls" : "stop",
            },
        ],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    };
}

function writeJsonResponse(
    res: http.ServerResponse,
    statusCode: number,
    headers: http.IncomingHttpHeaders,
    payload: unknown,
) {
    const responseBody = Buffer.from(JSON.stringify(payload), "utf-8");
    const nextHeaders: http.OutgoingHttpHeaders = {
        ...headers,
        "content-type": "application/json; charset=utf-8",
        "content-length": responseBody.length.toString(),
    };

    delete nextHeaders["content-encoding"];
    delete nextHeaders["transfer-encoding"];

    res.writeHead(statusCode, nextHeaders);
    res.end(responseBody);
}

function tryWriteShapedChatResponse(
    res: http.ServerResponse,
    requestPath: string,
    isStreamRequest: boolean,
    response: {
        statusCode: number;
        headers: http.IncomingHttpHeaders;
        body: Buffer;
    },
    requestModel: string,
): boolean {
    if (
        !isChatCompletionsPath(requestPath) ||
        isStreamRequest ||
        response.statusCode >= 400
    ) {
        return false;
    }

    try {
        const shaped = shapeResponsesAsChatCompletion(
            JSON.parse(response.body.toString("utf-8")) as Record<
                string,
                unknown
            >,
            requestModel,
        );
        writeJsonResponse(res, response.statusCode, response.headers, shaped);
        return true;
    } catch {
        return false;
    }
}

function makeLegacyChatStreamingRequest(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | null,
    extraHeaders: Record<string, string>,
    pipeRes: http.ServerResponse,
    timeoutMs = 30_000,
    fallbackModel = "",
    payloadCaptureMeta?: {
        originalPath: string;
        upstreamPath: string;
        isStreamRequest: boolean;
    },
): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}> {
    return new Promise((resolve, reject) => {
        const url = new URL(path, RADROUTER_URL);
        const isHttps = url.protocol === "https:";
        const transport = isHttps ? https : http;

        const outHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, val] of Object.entries(headers)) {
            if (key === "host" || key === "connection") continue;
            outHeaders[key] = val;
        }
        for (const [key, val] of Object.entries(extraHeaders)) {
            outHeaders[key] = val;
        }
        if (body) {
            outHeaders["content-length"] = body.length.toString();
        }

        if (payloadCaptureMeta) {
            capturePayloadBoundary({
                stage: "upstream",
                method,
                originalPath: payloadCaptureMeta.originalPath,
                upstreamPath: payloadCaptureMeta.upstreamPath,
                isStreamRequest: payloadCaptureMeta.isStreamRequest,
                body,
                headers: outHeaders,
            });
        }

        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers: outHeaders,
            },
            (upstreamRes) => {
                const statusCode = upstreamRes.statusCode || 500;

                if (statusCode >= 400) {
                    const chunks: Buffer[] = [];
                    upstreamRes.on("data", (chunk) =>
                        chunks.push(
                            Buffer.isBuffer(chunk)
                                ? chunk
                                : Buffer.from(String(chunk), "utf-8"),
                        ),
                    );
                    upstreamRes.on("end", () => {
                        const responseBody = Buffer.concat(chunks);
                        pipeRes.writeHead(statusCode, upstreamRes.headers);
                        pipeRes.end(responseBody);
                        resolve({
                            statusCode,
                            headers: upstreamRes.headers,
                            body: responseBody,
                        });
                    });
                    return;
                }

                const nextHeaders: http.OutgoingHttpHeaders = {
                    ...upstreamRes.headers,
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                };
                delete nextHeaders["content-length"];
                delete nextHeaders["content-encoding"];
                delete nextHeaders["transfer-encoding"];

                pipeRes.writeHead(statusCode, nextHeaders);

                const state: LegacyChatStreamState = {
                    id: `chatcmpl_${Math.random().toString(36).slice(2, 14)}`,
                    model: fallbackModel,
                    created: Math.floor(Date.now() / 1000),
                    firstChunkSent: false,
                    hasToolCalls: false,
                    outputIndexToToolIndex: new Map(),
                    nextToolIndex: 0,
                    completed: false,
                    inputTokens: 0,
                    outputTokens: 0,
                };

                let buffered = "";
                upstreamRes.setEncoding("utf8");

                // Split on double-newline to get complete SSE frames.
                // The worker emits events with the type in the "event:" field,
                // so we process full frames rather than individual lines.
                upstreamRes.on("data", (chunk: string) => {
                    buffered += chunk;
                    const frames = buffered.split("\n\n");
                    buffered = frames.pop() ?? "";

                    for (const frame of frames) {
                        if (!frame.trim()) continue;
                        const translated = translateResponsesFrameToChat(
                            frame,
                            state,
                        );
                        if (translated) {
                            pipeRes.write(translated);
                        }
                    }
                });

                upstreamRes.on("end", () => {
                    if (buffered.trim()) {
                        const translated = translateResponsesFrameToChat(
                            buffered,
                            state,
                        );
                        if (translated) {
                            pipeRes.write(translated);
                        }
                    }

                    if (!state.completed) {
                        if (!state.firstChunkSent) {
                            state.firstChunkSent = true;
                            pipeRes.write(
                                legacyChatStreamChunk(state, [
                                    {
                                        index: 0,
                                        delta: {
                                            role: "assistant",
                                            content: "",
                                        },
                                        finish_reason: null,
                                    },
                                ]),
                            );
                        }

                        pipeRes.write(
                            legacyChatStreamChunk(state, [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: state.hasToolCalls
                                        ? "tool_calls"
                                        : "stop",
                                },
                            ]),
                        );
                        pipeRes.write("data: [DONE]\n\n");
                    }

                    pipeRes.end();

                    const streamUsageBody = Buffer.from(
                        JSON.stringify({
                            usage: {
                                input_tokens: state.inputTokens,
                                output_tokens: state.outputTokens,
                            },
                        }),
                        "utf-8",
                    );

                    resolve({
                        statusCode,
                        headers: upstreamRes.headers,
                        body: streamUsageBody,
                    });
                });
            },
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });

        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Anthropic Messages API streaming request
// ---------------------------------------------------------------------------

function makeAnthropicMessagesStreamingRequest(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | null,
    extraHeaders: Record<string, string>,
    pipeRes: http.ServerResponse,
    timeoutMs = 30_000,
    fallbackModel = "",
    payloadCaptureMeta?: {
        originalPath: string;
        upstreamPath: string;
        isStreamRequest: boolean;
    },
): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}> {
    return new Promise((resolve, reject) => {
        const url = new URL(path, RADROUTER_URL);
        const isHttps = url.protocol === "https:";
        const transport = isHttps ? https : http;

        const outHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, val] of Object.entries(headers)) {
            if (key === "host" || key === "connection") continue;
            outHeaders[key] = val;
        }
        for (const [key, val] of Object.entries(extraHeaders)) {
            outHeaders[key] = val;
        }
        if (body) {
            outHeaders["content-length"] = body.length.toString();
        }

        if (payloadCaptureMeta) {
            capturePayloadBoundary({
                stage: "upstream",
                method,
                originalPath: payloadCaptureMeta.originalPath,
                upstreamPath: payloadCaptureMeta.upstreamPath,
                isStreamRequest: payloadCaptureMeta.isStreamRequest,
                body,
                headers: outHeaders,
            });
        }

        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers: outHeaders,
            },
            (upstreamRes) => {
                const statusCode = upstreamRes.statusCode || 500;

                if (statusCode >= 400) {
                    const chunks: Buffer[] = [];
                    upstreamRes.on("data", (chunk) =>
                        chunks.push(
                            Buffer.isBuffer(chunk)
                                ? chunk
                                : Buffer.from(String(chunk), "utf-8"),
                        ),
                    );
                    upstreamRes.on("end", () => {
                        const responseBody = Buffer.concat(chunks);
                        pipeRes.writeHead(statusCode, upstreamRes.headers);
                        pipeRes.end(responseBody);
                        resolve({
                            statusCode,
                            headers: upstreamRes.headers,
                            body: responseBody,
                        });
                    });
                    return;
                }

                const nextHeaders: http.OutgoingHttpHeaders = {
                    ...upstreamRes.headers,
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                };
                delete nextHeaders["content-length"];
                delete nextHeaders["content-encoding"];
                delete nextHeaders["transfer-encoding"];

                pipeRes.writeHead(statusCode, nextHeaders);

                // Strip provider prefix for the model display name.
                const modelDisplay = fallbackModel.includes("/")
                    ? fallbackModel.split("/").slice(1).join("/")
                    : fallbackModel;

                const state: AnthropicMessagesStreamState = {
                    id: `msg_${Math.random().toString(36).slice(2, 18)}`,
                    model: modelDisplay || fallbackModel,
                    inputTokens: 0,
                    outputTokens: 0,
                    hasStarted: false,
                    hasTextBlock: false,
                    textBlockIndex: 0,
                    hasToolCalls: false,
                    outputIndexToContentIndex: new Map(),
                    nextContentIndex: 0,
                    completed: false,
                };

                let buffered = "";
                upstreamRes.setEncoding("utf8");

                // Split on double-newline to get complete SSE frames.
                // The worker emits events with the type in the "event:" field,
                // so we process full frames rather than individual lines.
                upstreamRes.on("data", (chunk: string) => {
                    buffered += chunk;
                    const frames = buffered.split("\n\n");
                    buffered = frames.pop() ?? "";

                    for (const frame of frames) {
                        if (!frame.trim()) continue;
                        const translated = translateResponsesFrameToMessages(
                            frame,
                            state,
                        );
                        if (translated) {
                            pipeRes.write(translated);
                        }
                    }
                });

                upstreamRes.on("end", () => {
                    if (buffered.trim()) {
                        const translated = translateResponsesFrameToMessages(
                            buffered,
                            state,
                        );
                        if (translated) {
                            pipeRes.write(translated);
                        }
                    }

                    // Emit a minimal well-formed completion if the upstream
                    // ended without sending a response.completed event.
                    if (!state.completed) {
                        if (!state.hasStarted) {
                            pipeRes.write(
                                sseEvent("message_start", {
                                    type: "message_start",
                                    message: {
                                        id: state.id,
                                        type: "message",
                                        role: "assistant",
                                        content: [],
                                        model: state.model,
                                        stop_reason: null,
                                        stop_sequence: null,
                                        usage: {
                                            input_tokens: 0,
                                            output_tokens: 0,
                                        },
                                    },
                                }),
                            );
                        }

                        if (state.hasTextBlock) {
                            pipeRes.write(
                                sseEvent("content_block_stop", {
                                    type: "content_block_stop",
                                    index: state.textBlockIndex,
                                }),
                            );
                        }

                        pipeRes.write(
                            sseEvent("message_delta", {
                                type: "message_delta",
                                delta: {
                                    stop_reason: state.hasToolCalls
                                        ? "tool_use"
                                        : "end_turn",
                                    stop_sequence: null,
                                },
                                usage: { output_tokens: state.outputTokens },
                            }),
                        );

                        pipeRes.write(
                            sseEvent("message_stop", {
                                type: "message_stop",
                            }),
                        );
                    }

                    pipeRes.end();

                    const streamUsageBody = Buffer.from(
                        JSON.stringify({
                            usage: {
                                input_tokens: state.inputTokens,
                                output_tokens: state.outputTokens,
                            },
                        }),
                        "utf-8",
                    );

                    resolve({
                        statusCode,
                        headers: upstreamRes.headers,
                        body: streamUsageBody,
                    });
                });
            },
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });

        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

function makeRequest(
    method: string,
    path: string,
    headers: http.IncomingHttpHeaders,
    body: Buffer | null,
    extraHeaders: Record<string, string>,
    pipeRes?: http.ServerResponse,
    timeoutMs = 30_000,
    payloadCaptureMeta?: {
        originalPath: string;
        upstreamPath: string;
        isStreamRequest: boolean;
    },
): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}> {
    return new Promise((resolve, reject) => {
        const url = new URL(path, RADROUTER_URL);
        const isHttps = url.protocol === "https:";
        const transport = isHttps ? https : http;

        const outHeaders: Record<string, string | string[] | undefined> = {};
        for (const [key, val] of Object.entries(headers)) {
            if (key === "host" || key === "connection") continue;
            outHeaders[key] = val;
        }
        for (const [key, val] of Object.entries(extraHeaders)) {
            outHeaders[key] = val;
        }
        if (body) {
            outHeaders["content-length"] = body.length.toString();
        }

        if (payloadCaptureMeta) {
            capturePayloadBoundary({
                stage: "upstream",
                method,
                originalPath: payloadCaptureMeta.originalPath,
                upstreamPath: payloadCaptureMeta.upstreamPath,
                isStreamRequest: payloadCaptureMeta.isStreamRequest,
                body,
                headers: outHeaders,
            });
        }

        const req = transport.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method,
                headers: outHeaders,
            },
            (res) => {
                const statusCode = res.statusCode || 500;

                // For successful stream responses, keep piping directly to client.
                if (pipeRes && statusCode < 400) {
                    pipeRes.writeHead(statusCode, res.headers);
                    res.pipe(pipeRes);
                    resolve({
                        statusCode,
                        headers: res.headers,
                        body: Buffer.alloc(0),
                    });
                    return;
                }

                // For non-stream requests OR stream errors, buffer body so we can
                // log/report upstream failure details before returning.
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const responseBody = Buffer.concat(chunks);

                    if (pipeRes) {
                        pipeRes.writeHead(statusCode, res.headers);
                        pipeRes.end(responseBody);
                    }

                    resolve({
                        statusCode,
                        headers: res.headers,
                        body: responseBody,
                    });
                });
            },
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });

        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const path = req.url || "/";
    const upstreamPath = normalizeUpstreamPath(path);

    logSection(`${method} ${path}`);
    if (upstreamPath !== path) {
        logStep("rewrite", `${path} -> ${upstreamPath}`);
    }

    const csrf = validateCsrfProtection(req);
    if (!csrf.ok) {
        logStep("csrf", csrf.reason);
        res.writeHead(403);
        res.end(JSON.stringify({ error: csrf.reason }));
        req.resume();
        return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));

    req.on("end", async () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : null;

        let normalizedBody = body;
        let isStreamRequest = false;
        let streamIdleTimeoutMs = 30_000;
        let requestModel = "";
        let requestMaxOutputTokens = 0;
        if (body) {
            capturePayloadBoundary({
                stage: "inbound",
                method,
                originalPath: path,
                upstreamPath,
                isStreamRequest: false,
                body,
                headers: req.headers,
            });

            try {
                const parsed = JSON.parse(body.toString("utf-8")) as Record<
                    string,
                    unknown
                >;
                const bodyRewrites: string[] = [];

                // Convert legacy chat-completions request shape to Responses shape.
                // This keeps compatibility with clients (like Zed) still posting
                // chat-style requests to /v1/chat/completions.
                if (
                    isChatCompletionsPath(path) ||
                    isAnthropicMessagesPath(path)
                ) {
                    if (Array.isArray(parsed.messages)) {
                        const normalizedFromMessages =
                            normalizeChatMessagesToResponsesInput(
                                parsed.messages,
                            );
                        const normalizedMessagesInput = Array.isArray(
                            normalizedFromMessages,
                        )
                            ? normalizedFromMessages
                            : [normalizedFromMessages];
                        parsed.input = Array.isArray(parsed.input)
                            ? [
                                  ...normalizedMessagesInput,
                                  ...(sanitizeResponsesInputItems(
                                      parsed.input,
                                  ) as unknown[]),
                              ]
                            : normalizedFromMessages;
                        bodyRewrites.push("messages->typed-input");
                    }
                    delete parsed.messages;

                    if (
                        parsed.max_output_tokens === undefined &&
                        typeof parsed.max_tokens === "number"
                    ) {
                        parsed.max_output_tokens = parsed.max_tokens;
                        delete parsed.max_tokens;
                        bodyRewrites.push("max_tokens->max_output_tokens");
                    }

                    if (
                        isAnthropicMessagesPath(path) &&
                        parsed.input === undefined &&
                        parsed.system !== undefined
                    ) {
                        parsed.input = [
                            {
                                type: "message",
                                role: "system",
                                content: [
                                    {
                                        type: "input_text",
                                        text:
                                            typeof parsed.system === "string"
                                                ? parsed.system
                                                : JSON.stringify(parsed.system),
                                    },
                                ],
                            },
                        ];
                        bodyRewrites.push("system->input");
                    }

                    if (
                        parsed.tools === undefined &&
                        Array.isArray(parsed.functions)
                    ) {
                        parsed.tools = parsed.functions;
                        delete parsed.functions;
                        bodyRewrites.push("functions->tools");
                    }

                    if (parsed.tools !== undefined) {
                        parsed.tools = isAnthropicMessagesPath(path)
                            ? normalizeAnthropicToolsToResponses(parsed.tools)
                            : normalizeChatToolsToResponses(parsed.tools);
                        bodyRewrites.push("tools->responses-tools");

                        if (
                            Array.isArray(parsed.tools) &&
                            parsed.tools.length === 0
                        ) {
                            delete parsed.tools;
                            bodyRewrites.push("dropped-empty-tools");
                        }
                    }

                    if (
                        parsed.tool_choice === undefined &&
                        parsed.function_call !== undefined
                    ) {
                        const functionCall = parsed.function_call;

                        if (typeof functionCall === "string") {
                            parsed.tool_choice = functionCall;
                        } else if (
                            functionCall &&
                            typeof functionCall === "object" &&
                            typeof (functionCall as Record<string, unknown>)
                                .name === "string"
                        ) {
                            parsed.tool_choice = {
                                type: "function",
                                name: (functionCall as Record<string, unknown>)
                                    .name as string,
                            };
                        }

                        delete parsed.function_call;
                        bodyRewrites.push("function_call->tool_choice");
                    }

                    if (
                        parsed.tool_choice &&
                        typeof parsed.tool_choice === "object" &&
                        !Array.isArray(parsed.tool_choice)
                    ) {
                        const tc = parsed.tool_choice as Record<
                            string,
                            unknown
                        >;
                        const fn =
                            tc.function && typeof tc.function === "object"
                                ? (tc.function as Record<string, unknown>)
                                : null;

                        if (
                            tc.type === "function" &&
                            fn &&
                            typeof fn.name === "string"
                        ) {
                            parsed.tool_choice = {
                                type: "function",
                                name: fn.name,
                            };
                            bodyRewrites.push(
                                "tool_choice.function->tool_choice.name",
                            );
                        }
                    }

                    if (
                        isAnthropicMessagesPath(path) &&
                        parsed.tool_choice &&
                        typeof parsed.tool_choice === "object" &&
                        !Array.isArray(parsed.tool_choice)
                    ) {
                        const toolChoice = parsed.tool_choice as Record<
                            string,
                            unknown
                        >;

                        if (toolChoice.type === "any") {
                            parsed.tool_choice = "required";
                            bodyRewrites.push("tool_choice.any->required");
                        } else if (
                            toolChoice.type === "tool" &&
                            typeof toolChoice.name === "string"
                        ) {
                            parsed.tool_choice = {
                                type: "function",
                                name: toolChoice.name,
                            };
                            bodyRewrites.push("tool_choice.tool->function");
                        }
                    }
                }

                const mappedModel = mapRequestedModel(parsed.model);
                if (
                    typeof parsed.model === "string" &&
                    typeof mappedModel === "string" &&
                    parsed.model !== mappedModel
                ) {
                    bodyRewrites.push(`model:${parsed.model}->${mappedModel}`);
                    parsed.model = mappedModel;
                }

                if (isAnthropicMessagesPath(path)) {
                    delete parsed.system;
                    delete parsed.max_tokens;
                    delete parsed.stop_sequences;
                    delete parsed.metadata;
                }

                parsed.input = sanitizeResponsesInputItems(parsed.input);
                parsed.messages = sanitizeResponsesInputItems(parsed.messages);

                normalizedBody = Buffer.from(JSON.stringify(parsed), "utf-8");

                if (bodyRewrites.length > 0) {
                    logStep("normalize", bodyRewrites.join("; "));
                }

                isStreamRequest = parsed.stream === true;

                normalizedBody = Buffer.from(JSON.stringify(parsed), "utf-8");

                capturePayloadBoundary({
                    stage: "normalized",
                    method,
                    originalPath: path,
                    upstreamPath,
                    isStreamRequest,
                    body: normalizedBody,
                });

                requestModel =
                    typeof parsed.model === "string" ? parsed.model : "";
                const model = requestModel.toLowerCase();
                const explicitTimeoutMs = Number(
                    process.env.RADROUTER_STREAM_TIMEOUT_MS || 0,
                );
                const responseMaxOutput =
                    typeof parsed.max_output_tokens === "number"
                        ? parsed.max_output_tokens
                        : 0;
                requestMaxOutputTokens = responseMaxOutput;
                const responseReasoning =
                    typeof parsed.reasoning === "object"
                        ? parsed.reasoning
                        : null;
                const isReasoningModel =
                    model.includes("gpt-5") ||
                    model.includes("o1") ||
                    model.includes("o3") ||
                    Boolean(responseReasoning);

                if (
                    isStreamRequest &&
                    (isReasoningModel || responseMaxOutput > 8192)
                ) {
                    streamIdleTimeoutMs = 300_000;
                }
                if (isStreamRequest && explicitTimeoutMs > 0) {
                    streamIdleTimeoutMs = explicitTimeoutMs;
                }
            } catch {}
        }

        try {
            const firstResponse = await makeRequest(
                method,
                upstreamPath,
                req.headers,
                normalizedBody,
                {},
                undefined,
                30_000,
                {
                    originalPath: path,
                    upstreamPath,
                    isStreamRequest,
                },
            );

            if (firstResponse.statusCode !== 402) {
                logStep(
                    "upstream",
                    `Direct response ${firstResponse.statusCode} (no payment required)`,
                );

                if (
                    tryWriteShapedChatResponse(
                        res,
                        path,
                        isStreamRequest,
                        firstResponse,
                        requestModel,
                    )
                ) {
                    return;
                }

                res.writeHead(firstResponse.statusCode, firstResponse.headers);
                res.end(firstResponse.body);
                return;
            }

            logStep("challenge", "Received HTTP 402 payment challenge");

            let paymentData: PaymentResponse;
            try {
                paymentData = JSON.parse(firstResponse.body.toString("utf-8"));
            } catch {
                res.writeHead(502);
                res.end(
                    JSON.stringify({
                        error: "Invalid 402 response from RadRouter",
                    }),
                );
                return;
            }

            if (!paymentData.accepts || paymentData.accepts.length === 0) {
                res.writeHead(502);
                res.end(
                    JSON.stringify({
                        error: "No payment options in 402 response",
                    }),
                );
                return;
            }

            const requirement = paymentData.accepts[0];

            const validationError = validateRequirement(requirement);
            if (validationError) {
                console.error(
                    `[x402] Requirement validation failed: ${validationError}`,
                );
                res.writeHead(502);
                res.end(
                    JSON.stringify({
                        error: `Payment requirement not supported: ${validationError}`,
                    }),
                );
                return;
            }

            console.log(
                `[x402] requirement         ${requirement.maxAmountRequired} SBC for ${upstreamPath}`,
            );

            logPricingEstimate({
                model: requestModel,
                normalizedRequestBody: normalizedBody,
                maxOutputTokens: requestMaxOutputTokens,
            });

            const xPayment = await signPermit(requirement);
            logStep("permit", `Signed by ${account.address}`);
            logStep("retry", "Forwarding paid request to RadRouter");

            if (isStreamRequest) {
                const paidStreamResponse = isChatCompletionsPath(path)
                    ? await makeLegacyChatStreamingRequest(
                          method,
                          upstreamPath,
                          req.headers,
                          normalizedBody,
                          { "x-payment": xPayment },
                          res,
                          streamIdleTimeoutMs,
                          requestModel,
                          {
                              originalPath: path,
                              upstreamPath,
                              isStreamRequest,
                          },
                      )
                    : isAnthropicMessagesPath(path)
                      ? await makeAnthropicMessagesStreamingRequest(
                            method,
                            upstreamPath,
                            req.headers,
                            normalizedBody,
                            { "x-payment": xPayment },
                            res,
                            streamIdleTimeoutMs,
                            requestModel,
                            {
                                originalPath: path,
                                upstreamPath,
                                isStreamRequest,
                            },
                        )
                      : await makeRequest(
                            method,
                            upstreamPath,
                            req.headers,
                            normalizedBody,
                            { "x-payment": xPayment },
                            res,
                            streamIdleTimeoutMs,
                        );

                const { verified, payer, tx } = extractPaymentHeaders(
                    paidStreamResponse.headers,
                );

                logStep(
                    "result",
                    `Stream upstream status ${paidStreamResponse.statusCode} (idle timeout ${streamIdleTimeoutMs}ms)`,
                );

                if (verified !== undefined) {
                    logStep("verified", `${verified}`);
                }
                if (payer) {
                    logStep("payer", `${payer}`);
                }
                if (tx) {
                    logTxDetails(tx);
                }

                if (paidStreamResponse.statusCode < 400) {
                    logActualUsageCost({
                        model: requestModel,
                        responseBody: paidStreamResponse.body,
                        authorizedMaxAmount: requirement.maxAmountRequired,
                    });
                }

                if (paidStreamResponse.statusCode >= 400) {
                    const upstreamBody = paidStreamResponse.body
                        .toString("utf-8")
                        .trim();

                    console.warn(
                        `[x402] stream-warning     Paid stream returned status ${paidStreamResponse.statusCode}.`,
                    );

                    logStreamBodyPreview(paidStreamResponse.body);
                }
            } else {
                const paidResponse = await makeRequest(
                    method,
                    upstreamPath,
                    req.headers,
                    normalizedBody,
                    {
                        "x-payment": xPayment,
                    },
                    undefined,
                    30_000,
                    {
                        originalPath: path,
                        upstreamPath,
                        isStreamRequest,
                    },
                );

                if (paidResponse.statusCode === 200) {
                    logStep("result", "Payment accepted. Response delivered.");
                } else {
                    logStep(
                        "result",
                        `Payment response status ${paidResponse.statusCode}`,
                    );
                }

                if (paidResponse.statusCode < 400) {
                    logActualUsageCost({
                        model: requestModel,
                        responseBody: paidResponse.body,
                        authorizedMaxAmount: requirement.maxAmountRequired,
                    });
                }

                const { tx, txState } = extractPaymentHeaders(
                    paidResponse.headers,
                );
                logTxDetails(tx, txState);

                if (
                    tryWriteShapedChatResponse(
                        res,
                        path,
                        isStreamRequest,
                        paidResponse,
                        requestModel,
                    )
                ) {
                    return;
                }

                res.writeHead(paidResponse.statusCode, paidResponse.headers);
                res.end(paidResponse.body);
            }
        } catch (err: any) {
            console.error("[proxy] Error:", err.message);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end(
                    JSON.stringify({ error: "Proxy error: " + err.message }),
                );
            }
        }
    });
});

async function startProxy() {
    try {
        await initializeSignerAndClients();
    } catch (err: any) {
        console.error(
            err?.message ||
                "[proxy] Failed to initialize private key. Check key source configuration.",
        );
        process.exit(1);
    }

    server.listen(PORT, "127.0.0.1", onServerListen);
}

async function onServerListen() {
    console.log("");
    console.log("  RadRouter x402 Proxy");
    console.log("  ====================");
    console.log(`  Wallet:    ${account.address}`);
    console.log(`  Proxy:     http://localhost:${PORT}`);
    console.log(`  RadRouter: ${RADROUTER_URL}`);
    console.log(`  Network:   Radius (Chain ID 723487)`);

    try {
        const { rusd, sbc } = await fetchStartupBalances();
        console.log(
            `  Balance:   ${formatUnits(rusd, 18)} RUSD | ${formatUnits(sbc, SBC_DECIMALS)} SBC`,
        );
    } catch (err: any) {
        console.warn(
            `  Balance:   unavailable (${err?.message || "failed to fetch balances"})`,
        );
    }

    console.log("");
    console.log("  Point your IDE to:");
    console.log(`    http://localhost:${PORT}/v1`);
    console.log(
        "  (chat/completions requests are normalized to Responses API automatically)",
    );
    console.log("");
    console.log("  Start command:");
    console.log("    npm run proxy:start");
    console.log("");
    console.log("  Payments are signed automatically with your local key.");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
}

void startProxy();
