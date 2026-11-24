import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, ExternalLink, Info, Sparkles, X } from 'lucide-react';
import type { Transaction } from '@stellar/stellar-sdk';
import { Button } from './Button';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useOptionalWalletConnection } from './WalletConnection/WalletConnectionContext';
import { StatusTimeline, type Milestone, type MilestoneStatus } from './StatusTimeline/StatusTimeline';
import { TransactionReceiptShare } from './StatusTimeline/TransactionReceiptShare';
import { CONTRACT_ID, buildTransactionExplorerUrl } from '../constants/stellar';
import {
  ClaimTransactionError,
  buildClaimTransaction,
  isTestnetNetworkPassphrase,
  signClaimTransaction,
  simulateClaimTransaction,
  submitAndPollClaimTransaction,
  type ClaimPollUpdate,
} from '../lib/soroban/claimTransaction';

export interface LockupClaimResult {
  hash?: string;
}

export interface LockupClaimModalProps {
  isOpen: boolean;
  onClose: () => void;
  unlockedAmount?: string;
  gasEstimate?: number;
  initialAutoClaim?: boolean;
  onClaim?: (options: { autoClaim: boolean }) => Promise<LockupClaimResult | void>;
  explorerBaseUrl?: string;
  /** Distribution period ID for Soroban claim transactions (defaults to 1). */
  periodId?: number;
  /** Optional polling overrides (primarily for testing). */
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

type SorobanPhase =
  | 'idle'
  | 'simulating'
  | 'simulated'
  | 'signing'
  | 'submitting'
  | 'polling'
  | 'confirmed'
  | 'error';

interface SimulationSummary {
  preparedTransaction: Transaction;
  estimatedFeeXlm: string;
  estimatedFeeStroops: string;
}

interface TimelineFailure {
  step: 'simulate' | 'sign' | 'submit' | 'confirm';
  reason: string;
}

type SorobanPhase =
  | 'idle'
  | 'simulating'
  | 'simulated'
  | 'signing'
  | 'submitting'
  | 'polling'
  | 'confirmed'
  | 'error';

interface SimulationSummary {
  preparedTransaction: Transaction;
  estimatedFeeXlm: string;
  estimatedFeeStroops: string;
}

interface TimelineFailure {
  step: 'simulate' | 'sign' | 'submit' | 'confirm';
  reason: string;
}



function buildSorobanMilestones(
  phase: SorobanPhase,
  failure: TimelineFailure | null,
  pollAttempt: number,
  estimatedFeeXlm?: string,
): Milestone[] {
  const resolveStatus = (
    step: 'simulate' | 'sign' | 'submit' | 'confirm',
    completedPhases: SorobanPhase[],
    activePhases: SorobanPhase[],
  ): MilestoneStatus => {
    if (failure?.step === step) return 'blocked';
    if (completedPhases.includes(phase)) return 'completed';
    if (activePhases.includes(phase)) return 'in-progress';
    return 'pending';
  };

  return [
    {
      id: 'simulate',
      label: 'Simulate',
      description:
        failure?.step === 'simulate'
          ? failure.reason
          : estimatedFeeXlm
            ? `Estimated fee: ${estimatedFeeXlm}`
            : 'Verify contract call & fee',
      status: resolveStatus(
        'simulate',
        ['simulated', 'signing', 'submitting', 'polling', 'confirmed'],
        ['simulating'],
      ),
    },
    {
      id: 'sign',
      label: 'Sign',
      description:
        failure?.step === 'sign'
          ? failure.reason
          : 'Approve in Freighter (Testnet)',
      status: resolveStatus('sign', ['submitting', 'polling', 'confirmed'], ['signing']),
    },
    {
      id: 'submit',
      label: 'Submit',
      description:
        failure?.step === 'submit'
          ? failure.reason
          : 'Broadcast to Soroban RPC',
      status: resolveStatus('submit', ['polling', 'confirmed'], ['submitting']),
    },
    {
      id: 'confirm',
      label: 'Confirm',
      description:
        failure?.step === 'confirm'
          ? failure.reason
          : phase === 'polling'
            ? `Polling ledger (attempt ${Math.max(1, pollAttempt)})…`
            : phase === 'confirmed'
              ? 'Confirmed on Stellar Testnet'
              : 'Await ledger finality',
      status: resolveStatus('confirm', ['confirmed'], ['polling']),
    },
  ];
}

function buildSorobanMilestones(
  phase: SorobanPhase,
  failure: TimelineFailure | null,
  pollAttempt: number,
  estimatedFeeXlm?: string,
): Milestone[] {
  const resolveStatus = (
    step: 'simulate' | 'sign' | 'submit' | 'confirm',
    completedPhases: SorobanPhase[],
    activePhases: SorobanPhase[],
  ): MilestoneStatus => {
    if (failure?.step === step) return 'blocked';
    if (completedPhases.includes(phase)) return 'completed';
    if (activePhases.includes(phase)) return 'in-progress';
    return 'pending';
  };

  return [
    {
      id: 'simulate',
      label: 'Simulate',
      description:
        failure?.step === 'simulate'
          ? failure.reason
          : estimatedFeeXlm
            ? `Estimated fee: ${estimatedFeeXlm}`
            : 'Verify contract call & fee',
      status: resolveStatus(
        'simulate',
        ['simulated', 'signing', 'submitting', 'polling', 'confirmed'],
        ['simulating'],
      ),
    },
    {
      id: 'sign',
      label: 'Sign',
      description:
        failure?.step === 'sign'
          ? failure.reason
          : 'Approve in Freighter (Testnet)',
      status: resolveStatus('sign', ['submitting', 'polling', 'confirmed'], ['signing']),
    },
    {
      id: 'submit',
      label: 'Submit',
      description:
        failure?.step === 'submit'
          ? failure.reason
          : 'Broadcast to Soroban RPC',
      status: resolveStatus('submit', ['polling', 'confirmed'], ['submitting']),
    },
    {
      id: 'confirm',
      label: 'Confirm',
      description:
        failure?.step === 'confirm'
          ? failure.reason
          : phase === 'polling'
            ? `Polling ledger (attempt ${Math.max(1, pollAttempt)})…`
            : phase === 'confirmed'
              ? 'Confirmed on Stellar Testnet'
              : 'Await ledger finality',
      status: resolveStatus('confirm', ['confirmed'], ['polling']),
    },
  ];
}

export const LockupClaimModal: React.FC<LockupClaimModalProps> = ({
  isOpen,
  onClose,
  unlockedAmount = '$12,480.00',
  gasEstimate = 22,
  initialAutoClaim = false,
  onClaim,
  explorerBaseUrl = 'https://stellar.expert/explorer/public/tx/',
  periodId = 1,
  pollIntervalMs,
  maxPollAttempts,
}) => {
  const wallet = useOptionalWalletConnection();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inFlightRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [autoClaim, setAutoClaim] = useState(initialAutoClaim);
  const [claimState, setClaimState] = useState<
    'idle' | 'pending' | 'confirmed' | 'later' | 'warning' | 'error'
  >('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [highGasConfirmed, setHighGasConfirmed] = useState(false);
  const [showAutoClaimInfo, setShowAutoClaimInfo] = useState(false);

  // Soroban testnet flow state
  const [sorobanPhase, setSorobanPhase] = useState<SorobanPhase>('idle');
  const [simulationInfo, setSimulationInfo] = useState<SimulationSummary | null>(null);
  const [timelineFailure, setTimelineFailure] = useState<TimelineFailure | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  const hasWalletContext = wallet !== null;
  const isWalletConnected = wallet?.status === 'connected' && Boolean(wallet.address);
  const isTestnet = isTestnetNetworkPassphrase(wallet?.networkPassphrase);
  const isNetworkMismatch = isWalletConnected && !isTestnet;
  const useSorobanFlow = !onClaim && hasWalletContext;

  const restoreFocus = useCallback(() => {
    const opener = openerRef.current;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      opener.focus();
    }
  }, []);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      setAutoClaim(initialAutoClaim);
      setClaimState('idle');
      setStatusMessage('');
      setTxHash(null);
      setHighGasConfirmed(false);
      setSorobanPhase('idle');
      setSimulationInfo(null);
      setTimelineFailure(null);
      setPollAttempt(0);
      setConfirmedAt(null);
      inFlightRef.current = false;
    }
  }, [isOpen, initialAutoClaim]);

  // useFocusTrap handles initial focus, Tab trapping, and return-focus.
  useFocusTrap(dialogRef, isOpen);

  // Escape key handling (useFocusTrap only traps Tab)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  const milestones = useMemo(
    () =>
      buildSorobanMilestones(
        sorobanPhase,
        timelineFailure,
        pollAttempt,
        simulationInfo?.estimatedFeeXlm,
      ),
    [sorobanPhase, timelineFailure, pollAttempt, simulationInfo?.estimatedFeeXlm],
  );

  if (!isOpen) return null;

  const handleSorobanSimulate = async () => {
    if (!wallet || !wallet.address || !isTestnet) {
      setClaimState('error');
      setStatusMessage(
        isNetworkMismatch
          ? 'Signing refused: switch Freighter to Stellar Testnet to claim.'
          : 'Connect a Freighter wallet on Stellar Testnet to claim on-chain.',
      );
      return;
    }

    inFlightRef.current = true;
    setClaimState('pending');
    setSorobanPhase('simulating');
    setTimelineFailure(null);
    setSimulationInfo(null);
    setTxHash(null);
    setStatusMessage('Simulating claim transaction on Stellar Testnet…');

    try {
      const tx = await buildClaimTransaction(wallet.address, periodId);
      const sim = await simulateClaimTransaction(tx);

      if (!sim.ok) {
        setSorobanPhase('error');
        setClaimState('error');
        setTimelineFailure({ step: 'simulate', reason: sim.error });
        setStatusMessage(`Simulation failed: ${sim.error}`);
        return;
      }

      setSimulationInfo({
        preparedTransaction: sim.preparedTransaction,
        estimatedFeeXlm: sim.estimatedFeeXlm,
        estimatedFeeStroops: sim.estimatedFeeStroops,
      });
      setSorobanPhase('simulated');
      setClaimState('idle');
      setStatusMessage(
        `Simulation succeeded. Estimated network fee: ${sim.estimatedFeeXlm} (${sim.estimatedFeeStroops} stroops). Review and sign to submit.`,
      );
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'Unable to simulate claim transaction.';
      setSorobanPhase('error');
      setClaimState('error');
      setTimelineFailure({ step: 'simulate', reason: message });
      setStatusMessage(message);
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleSorobanSignAndSubmit = async () => {
    if (!wallet || !wallet.address || !simulationInfo) {
      return;
    }

    if (!isTestnetNetworkPassphrase(wallet.networkPassphrase)) {
      const message = 'Signing refused: switch Freighter to Stellar Testnet to claim.';
      setSorobanPhase('error');
      setClaimState('error');
      setTimelineFailure({ step: 'sign', reason: message });
      setStatusMessage(message);
      return;
    }

    inFlightRef.current = true;
    setClaimState('pending');
    setSorobanPhase('signing');
    setTimelineFailure(null);
    setPollAttempt(0);
    setStatusMessage('Waiting for Freighter signature on Stellar Testnet…');

    try {
      const { signedTxXdr } = await signClaimTransaction(
        simulationInfo.preparedTransaction,
        wallet.networkPassphrase,
        wallet.address,
      );

      setSorobanPhase('submitting');
      setStatusMessage('Submitting signed transaction to Stellar Testnet…');

      const handlePollStatus = (update: ClaimPollUpdate) => {
        setTxHash(update.hash);
        if (update.status === 'NOT_FOUND') {
          setSorobanPhase('polling');
          setPollAttempt(update.attempt ?? 1);
          setStatusMessage('Transaction submitted. Waiting for ledger confirmation…');
        } else if (update.status === 'SUCCESS') {
          setSorobanPhase('confirmed');
        } else if (update.status === 'FAILED') {
          setSorobanPhase('error');
        }
      };

      const submission = await submitAndPollClaimTransaction(signedTxXdr, {
        onStatus: handlePollStatus,
        pollIntervalMs,
        maxAttempts: maxPollAttempts,
      });

      setTxHash(submission.hash);
      setConfirmedAt(new Date().toLocaleString());
      setSorobanPhase('confirmed');
      setClaimState('confirmed');
      setStatusMessage('Claim confirmed on Stellar Testnet.');
    } catch (error) {
      setSorobanPhase('error');
      setClaimState('error');

      if (error instanceof ClaimTransactionError) {
        if (error.txHash) {
          setTxHash(error.txHash);
        }
        const step: TimelineFailure['step'] =
          error.code === 'NETWORK_MISMATCH' ||
          error.code === 'USER_REJECTED' ||
          error.code === 'SIGNING_FAILED' ||
          (error.code === 'TIMEOUT' && !error.txHash)
            ? 'sign'
            : error.code === 'SUBMIT_FAILED'
              ? 'submit'
              : 'confirm';
        setTimelineFailure({ step, reason: error.message });
        setStatusMessage(error.message);
      } else {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Unable to complete claim transaction. Please try again.';
        setTimelineFailure({ step: 'confirm', reason: message });
        setStatusMessage(message);
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleClaimNow = async () => {
    if (inFlightRef.current || claimState === 'pending') {
      return;
    }

    if (!unlockedAmount || unlockedAmount === '$0.00') {
      setClaimState('error');
      setStatusMessage('Nothing is currently available to claim.');
      return;
    }

    if (useSorobanFlow) {
      if (sorobanPhase === 'simulated' && simulationInfo) {
        await handleSorobanSignAndSubmit();
      } else {
        await handleSorobanSimulate();
      }
      return;
    }

    if (gasEstimate >= 80 && !highGasConfirmed) {
      setHighGasConfirmed(true);
      setClaimState('warning');
      setStatusMessage(
        'High gas fees may reduce your expected proceeds. Consider waiting or using auto-claim.',
      );
      return;
    }

    inFlightRef.current = true;
    setClaimState('pending');
    setStatusMessage('Submitting claim request…');
    setTxHash(null);

    try {
      const result: LockupClaimResult | void = await (onClaim ? onClaim({ autoClaim }) : Promise.resolve({}));
      const resolvedHash =
        result && typeof result === 'object' && typeof result.hash === 'string' && result.hash.trim()
          ? result.hash.trim()
          : null;
      setTxHash(resolvedHash);
      setClaimState('confirmed');
      setStatusMessage('Claim request queued. We will keep you updated as it confirms.');
    } catch (error) {
      setClaimState('error');
      setStatusMessage(
        error instanceof Error && error.message
          ? error.message
          : 'Unable to submit claim request. Please try again.',
      );
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleClaimLater = () => {
    if (inFlightRef.current || claimState === 'pending') {
      return;
    }
    setHighGasConfirmed(false);
    setTxHash(null);
    setSorobanPhase('idle');
    setSimulationInfo(null);
    setTimelineFailure(null);
    setClaimState('later');
    setStatusMessage('We will remind you again at a better time to claim this unlock.');
  };

  const isPending = claimState === 'pending';
  const gasLabel = gasEstimate >= 80 ? 'High' : gasEstimate >= 50 ? 'Moderate' : 'Low';
  const explorerUrl = txHash
    ? useSorobanFlow
      ? buildTransactionExplorerUrl(txHash)
      : `${explorerBaseUrl}${encodeURIComponent(txHash)}`
    : null;
  const isSorobanDisabled = useSorobanFlow && (!isWalletConnected || isNetworkMismatch);

  const primaryButtonLabel = useSorobanFlow
    ? sorobanPhase === 'simulated'
      ? 'Sign & submit'
      : 'Claim now'
    : claimState === 'warning'
      ? 'Claim anyway'
      : 'Claim now';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 py-6"
      onClick={handleClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl outline-none dark:border-slate-700 dark:bg-slate-900"
        dir="auto"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Unlock available</p>
            <h2 id={titleId} className="mt-2 text-2xl font-semibold text-slate-900 dark:text-white">
              Claim your unlocked balance
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
            aria-label="Close claim modal"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <p id={descriptionId} className="mt-4 text-sm leading-6 text-slate-600 dark:text-slate-300">
          Your lockup has unlocked partially. Choose how you want to receive the available balance.
        </p>

        {useSorobanFlow && !isWalletConnected && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Connect a Freighter wallet on Stellar Testnet to enable on-chain claiming.</span>
          </div>
        )}

        {useSorobanFlow && isNetworkMismatch && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Signing refused: Freighter is connected to a mismatched network. Switch to Stellar
              Testnet to claim.
            </span>
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/70">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Unlocked amount</p>
              <p className="mt-1 text-3xl font-semibold text-slate-900 dark:text-white">{unlockedAmount}</p>
            </div>
            <div className="rounded-full bg-primary/10 p-3 text-primary">
              <Sparkles size={20} aria-hidden="true" />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm dark:border-slate-700 dark:bg-slate-900/80">
            <div>
              <p className="font-medium text-slate-700 dark:text-slate-200">Estimated gas</p>
              <p className="text-slate-500 dark:text-slate-400">
                {simulationInfo
                  ? 'simulated Soroban testnet fee'
                  : `${gasLabel.toLowerCase()} network fee estimate`}
              </p>
            </div>
            <div className="text-right">
              {simulationInfo ? (
                <>
                  <p className="font-semibold text-slate-900 dark:text-white">
                    {simulationInfo.estimatedFeeXlm}
                  </p>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    {simulationInfo.estimatedFeeStroops} stroops
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-slate-900 dark:text-white">{gasEstimate}%</p>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    ~${Math.max(8, Math.round(gasEstimate * 1.2)).toFixed(0)} fee
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-slate-100 p-2 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Info size={16} aria-hidden="true" />
            </div>
            <div className="flex-1">
              <div className="flex items-start justify-between gap-2">
                <label htmlFor="auto-claim-toggle" className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  <input
                    id="auto-claim-toggle"
                    type="checkbox"
                    checked={autoClaim}
                    onChange={(event) => setAutoClaim(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-primary focus:ring-primary"
                  />
                  Auto-claim on next unlock
                </label>
                <button
                  type="button"
                  onClick={() => setShowAutoClaimInfo((value) => !value)}
                  className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                  aria-expanded={showAutoClaimInfo}
                  aria-controls="auto-claim-info"
                  aria-label="Learn more about auto-claim"
                >
                  <Info size={16} aria-hidden="true" />
                </button>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                We will claim automatically the next time this lockup unlocks, so you do not need to revisit this screen.
              </p>
              {showAutoClaimInfo && (
                <div id="auto-claim-info" role="tooltip" className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-600 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-300">
                  Auto-claim keeps the process hands-off, but you can still change your preference later from the account settings.
                </div>
              )}
            </div>
          </div>
        </div>

        {useSorobanFlow && sorobanPhase !== 'idle' && (
          <div className="mt-4">
            <StatusTimeline
              milestones={milestones}
              orientation="horizontal"
              ariaLabel="Claim transaction status"
            />
          </div>
        )}

        {claimState === 'warning' && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>High gas fees may reduce your expected proceeds. Review the estimate before continuing.</span>
          </div>
        )}

        {claimState === 'error' && (
          <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {statusMessage}
          </div>
        )}

        {((claimState !== 'idle' && claimState !== 'warning' && claimState !== 'error') ||
          (useSorobanFlow && sorobanPhase === 'simulated' && statusMessage)) && (
          <div role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            <p>{statusMessage}</p>
            {txHash && explorerUrl && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span>Transaction hash:</span>
                <code className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-emerald-900">
                  {txHash}
                </code>
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-emerald-800 underline hover:text-emerald-950"
                >
                  View on explorer
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
            )}
          </div>
        )}

        {useSorobanFlow && sorobanPhase === 'confirmed' && txHash && wallet?.address && (
          <div className="mt-4">
            <TransactionReceiptShare
              transactionId={`claim-period-${periodId}`}
              transactionHash={txHash}
              explorerUrl={explorerUrl ?? undefined}
              date={confirmedAt ?? new Date().toLocaleString()}
              amount={unlockedAmount}
              currency="USDC"
              status="completed"
              senderWallet={CONTRACT_ID}
              recipientWallet={wallet.address}
            />
          </div>
        )}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClaimLater}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Claim later
          </Button>
          <Button
            type="button"
            onClick={handleClaimNow}
            loading={isPending}
            disabled={isPending || isSorobanDisabled}
            className="w-full sm:w-auto"
          >
            {primaryButtonLabel}
            <ChevronRight size={16} className="ml-2 inline" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
};
