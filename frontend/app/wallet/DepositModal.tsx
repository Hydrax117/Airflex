"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/auth";
import { CurrencyInput } from "../../components/CurrencyInput";

// ---------------------------------------------------------------------------
// Paystack inline checkout (Issue #25)
//
// Paystack's popup is a script loaded from their CDN that attaches a global.
// It is loaded on demand rather than in the app shell: most sessions never
// deposit, and a payment provider's script is not something to put on every
// page load for everyone.
// ---------------------------------------------------------------------------

const PAYSTACK_SCRIPT_SRC = "https://js.paystack.co/v2/inline.js";

/** Smallest deposit Paystack will accept for this integration, in naira. */
export const MIN_DEPOSIT_NAIRA = 100;

interface PaystackPopup {
  resumeTransaction: (
    accessCode: string,
    callbacks?: {
      onSuccess?: (transaction: { reference?: string }) => void;
      onCancel?: () => void;
      onError?: (error: { message?: string }) => void;
    },
  ) => void;
}

declare global {
  interface Window {
    PaystackPop?: new () => PaystackPopup;
  }
}

interface InitializeResponse {
  access_code?: string;
  reference?: string;
  error?: string;
}

/** The user's dedicated NGN account, as returned by `GET /api/v1/wallet`. */
export interface VirtualAccount {
  accountNumber: string;
  bankName: string | null;
}

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the deposit has been confirmed, so the page can refresh. */
  onDepositSuccess: () => void;
  /** Null while Paystack is still provisioning the account. */
  virtualAccount?: VirtualAccount | null;
}

/** How long the copy button stays in its confirmed state (Issue #335). */
export const COPIED_FEEDBACK_MS = 2_000;

/**
 * Copy-to-clipboard control for the virtual account number (Issue #335).
 *
 * Users transfer from a bank app on the same phone, where selecting text
 * inside a modal is fiddly and a mistyped digit sends money nowhere
 * recoverable — so the number is never meant to be retyped by hand.
 */
export function CopyAccountNumberButton({
  accountNumber,
}: {
  accountNumber: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A timer left running after unmount would set state on a dead component.
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(accountNumber);
      setFailed(false);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // Clipboard access can be denied outright (insecure origin, permission
      // policy). Say so rather than silently doing nothing, so the user knows
      // to select the number manually.
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={`Copy account number ${accountNumber}`}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
          data-testid="copy-icon"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
        {copied ? "Copied!" : "Copy"}
      </button>

      {failed && (
        <span role="alert" className="text-[11px] text-red-600 dark:text-red-400">
          Could not copy — select the number manually.
        </span>
      )}
    </div>
  );
}

type Status = "idle" | "initializing" | "awaiting_payment" | "confirming" | "success";

/** How long to keep polling for the credited balance before giving up. */
const CONFIRM_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Validate the amount field.
 *
 * Returns the reason it is invalid, or null when it is fine. Separated from the
 * component so the rules can be unit tested without rendering.
 */
export function validateDepositAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "Enter an amount to deposit.";

  // Reject anything that is not a plain decimal number. `Number()` alone would
  // happily accept "0x10", "1e5" and " 12 ", none of which a user meant to type.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return "Enter a valid amount, for example 500 or 500.50.";
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "Enter a valid amount.";
  if (value < MIN_DEPOSIT_NAIRA) {
    return `The minimum deposit is ₦${MIN_DEPOSIT_NAIRA.toLocaleString()}.`;
  }

  return null;
}

/** Load the Paystack inline script once, reusing it across opens. */
export function loadPaystackScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Paystack can only load in the browser"));
  }
  if (window.PaystackPop) return Promise.resolve();

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${PAYSTACK_SCRIPT_SRC}"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Could not load the Paystack checkout.")),
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PAYSTACK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the Paystack checkout."));
    document.body.appendChild(script);
  });
}

export default function DepositModal({
  isOpen,
  onClose,
  onDepositSuccess,
  virtualAccount = null,
}: DepositModalProps) {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Timers are cleared on unmount and on close so a dismissed modal cannot keep
  // polling in the background.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (pollDeadline.current) clearTimeout(pollDeadline.current);
    pollTimer.current = null;
    pollDeadline.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Reset when the modal is closed so it does not reopen showing the last
  // attempt's error or success.
  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      setAmount("");
      setStatus("idle");
      setError(null);
    }
  }, [isOpen, stopPolling]);

  /**
   * Poll the wallet until the deposit lands.
   *
   * Paystack confirms to the browser before the webhook has necessarily reached
   * the server, so the balance is not guaranteed to be current the moment the
   * popup closes. Polling briefly closes that window without the UI claiming a
   * balance it has not seen.
   */
  const confirmDeposit = useCallback(() => {
    setStatus("confirming");
    stopPolling();

    pollTimer.current = setInterval(() => {
      onDepositSuccess();
    }, POLL_INTERVAL_MS);

    pollDeadline.current = setTimeout(() => {
      stopPolling();
      setStatus("success");
      onDepositSuccess();
    }, CONFIRM_TIMEOUT_MS);
  }, [onDepositSuccess, stopPolling]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const invalid = validateDepositAmount(amount);
    if (invalid) {
      setError(invalid);
      return;
    }

    const token = getToken();
    if (!token) {
      setError("Your session has expired. Please sign in again.");
      return;
    }

    setStatus("initializing");

    try {
      const response = await fetch(`${apiUrl}/api/wallet/deposit/initialize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: Number(amount) }),
      });

      const data = (await response.json()) as InitializeResponse;

      if (!response.ok || !data.access_code) {
        throw new Error(data.error ?? "Could not start the deposit. Please try again.");
      }

      await loadPaystackScript();
      if (!window.PaystackPop) {
        throw new Error("Could not load the Paystack checkout.");
      }

      setStatus("awaiting_payment");

      const popup = new window.PaystackPop();
      popup.resumeTransaction(data.access_code, {
        onSuccess: () => confirmDeposit(),
        // Dismissal and failure both leave the modal open with an explanation:
        // closing it would lose the amount the user already typed.
        onCancel: () => {
          setStatus("idle");
          setError("Payment cancelled. Your wallet has not been charged.");
        },
        onError: (err) => {
          setStatus("idle");
          setError(err?.message ?? "The payment could not be completed. Please try again.");
        },
      });
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (!isOpen) return null;

  const busy = status === "initializing" || status === "awaiting_payment" || status === "confirming";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-start justify-between">
          <h2
            id="deposit-modal-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Deposit Funds
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close deposit dialog"
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        {status === "success" ? (
          <div className="py-6 text-center" data-testid="deposit-success">
            <p className="text-base font-semibold text-green-600 dark:text-green-400">
              Deposit successful
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Your wallet balance has been updated.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {virtualAccount && (
              <section
                aria-labelledby="virtual-account-heading"
                data-testid="virtual-account"
                className="mb-5 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40"
              >
                <h3
                  id="virtual-account-heading"
                  className="text-sm font-semibold text-gray-900 dark:text-gray-100"
                >
                  Transfer from your bank
                </h3>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Send money to this account and your wallet is credited
                  automatically.
                </p>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      data-testid="virtual-account-number"
                      className="font-mono text-lg font-bold tracking-wider text-gray-900 dark:text-gray-100"
                    >
                      {virtualAccount.accountNumber}
                    </p>
                    {virtualAccount.bankName && (
                      <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                        {virtualAccount.bankName}
                      </p>
                    )}
                  </div>

                  <CopyAccountNumberButton
                    accountNumber={virtualAccount.accountNumber}
                  />
                </div>
              </section>
            )}

            <form onSubmit={handleSubmit} noValidate>
              {virtualAccount && (
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  Or pay by card
                </p>
              )}
              <label
                htmlFor="deposit-amount"
                className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                Amount
              </label>
              <CurrencyInput
                id="deposit-amount"
                name="amount"
                value={amount}
                min={MIN_DEPOSIT_NAIRA}
                onChange={(val) => {
                  setAmount(val ? String(val) : "");
                  if (error) setError(null);
                }}
                placeholder={`${MIN_DEPOSIT_NAIRA}`}
                disabled={busy}
              />
              <p
                id="deposit-amount-hint"
                className="mt-1 text-xs text-gray-500 dark:text-gray-400"
              >
                Minimum deposit ₦{MIN_DEPOSIT_NAIRA.toLocaleString()} (NGN)
              </p>

              {error && (
                <p
                  role="alert"
                  data-testid="deposit-error"
                  className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === "initializing" && "Starting…"}
                {status === "awaiting_payment" && "Waiting for payment…"}
                {status === "confirming" && "Confirming…"}
                {status === "idle" && "Continue to Payment"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
