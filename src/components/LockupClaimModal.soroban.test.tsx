import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Networks, type Transaction } from '@stellar/stellar-sdk';
import { LockupClaimModal } from './LockupClaimModal';
import { buildTransactionExplorerUrl } from '../constants/stellar';
import * as walletContext from './WalletConnection/WalletConnectionContext';
import * as claimTx from '../lib/soroban/claimTransaction';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_TX_HASH = 'b'.repeat(64);
const MOCK_TX = { toXDR: () => 'AAAAmockXdr==' } as unknown as Transaction;

function mockWalletState(overrides: {
  status?: walletContext.WalletStatus;
  address?: string | null;
  networkPassphrase?: string | null;
}) {
  vi.spyOn(walletContext, 'useOptionalWalletConnection').mockReturnValue({
    address: overrides.address ?? null,
    networkPassphrase: overrides.networkPassphrase ?? null,
    network: overrides.networkPassphrase === Networks.TESTNET ? 'TESTNET' : 'PUBLIC',
    status: overrides.status ?? 'idle',
    error: null,
    detection: 'detected',
    chain: null,
    chainId: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
}

describe('LockupClaimModal — Soroban testnet claim flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables on-chain claiming when wallet is not connected', () => {
    mockWalletState({ status: 'idle', address: null, networkPassphrase: null });

    render(<LockupClaimModal isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /connect a freighter wallet on stellar testnet/i,
    );
    expect(screen.getByRole('button', { name: /claim now/i })).toBeDisabled();
  });

  it('refuses signing on a mismatched network with a clear message', () => {
    mockWalletState({
      status: 'connected',
      address: TEST_ADDRESS,
      networkPassphrase: Networks.PUBLIC,
    });
    const signSpy = vi.spyOn(claimTx, 'signClaimTransaction');

    render(<LockupClaimModal isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/signing refused.*mismatched network/i);
    expect(screen.getByRole('button', { name: /claim now/i })).toBeDisabled();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('surfaces simulation errors and never reaches the signing step', async () => {
    const user = userEvent.setup();
    mockWalletState({
      status: 'connected',
      address: TEST_ADDRESS,
      networkPassphrase: Networks.TESTNET,
    });

    vi.spyOn(claimTx, 'buildClaimTransaction').mockResolvedValue(MOCK_TX);
    vi.spyOn(claimTx, 'simulateClaimTransaction').mockResolvedValue({
      ok: false,
      error: 'HostError: AlreadyClaimed',
    });
    const signSpy = vi.spyOn(claimTx, 'signClaimTransaction');

    render(<LockupClaimModal isOpen onClose={vi.fn()} periodId={3} />);

    await user.click(screen.getByRole('button', { name: /claim now/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/simulation failed: HostError: AlreadyClaimed/i);
    });
    expect(screen.getByTestId('st-milestone-simulate')).toBeInTheDocument();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('simulates, surfaces fee, signs on testnet, polls to SUCCESS, and renders explorer link + receipt', async () => {
    const user = userEvent.setup();
    mockWalletState({
      status: 'connected',
      address: TEST_ADDRESS,
      networkPassphrase: Networks.TESTNET,
    });

    vi.spyOn(claimTx, 'buildClaimTransaction').mockResolvedValue(MOCK_TX);
    vi.spyOn(claimTx, 'simulateClaimTransaction').mockResolvedValue({
      ok: true,
      preparedTransaction: MOCK_TX,
      minResourceFee: '25000',
      estimatedFeeStroops: '25100',
      estimatedFeeXlm: '0.00251 XLM',
    });
    const signSpy = vi
      .spyOn(claimTx, 'signClaimTransaction')
      .mockResolvedValue({ signedTxXdr: 'AAAAsigned==' });
    vi.spyOn(claimTx, 'submitAndPollClaimTransaction').mockImplementation(
      async (_xdr, options) => {
        options?.onStatus?.({ status: 'SUBMITTED', hash: VALID_TX_HASH });
        options?.onStatus?.({ status: 'NOT_FOUND', hash: VALID_TX_HASH, attempt: 1 });
        options?.onStatus?.({ status: 'SUCCESS', hash: VALID_TX_HASH, attempt: 2, ledger: 500 });
        return {
          status: 'SUCCESS',
          hash: VALID_TX_HASH,
          ledger: 500,
          explorerUrl: buildTransactionExplorerUrl(VALID_TX_HASH),
        };
      },
    );

    render(
      <LockupClaimModal
        isOpen
        onClose={vi.fn()}
        periodId={7}
        pollIntervalMs={1}
        maxPollAttempts={3}
      />,
    );

    // Step 1: Simulate
    await user.click(screen.getByRole('button', { name: /claim now/i }));

    await waitFor(() => {
      expect(screen.getByText('0.00251 XLM')).toBeInTheDocument();
    });
    expect(screen.getAllByText(/25100 stroops/i).length).toBeGreaterThanOrEqual(1);
    expect(signSpy).not.toHaveBeenCalled();

    // Step 2: Sign & submit
    await user.click(screen.getByRole('button', { name: /sign & submit/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/claim confirmed on stellar testnet/i);
    });

    expect(signSpy).toHaveBeenCalledWith(MOCK_TX, Networks.TESTNET, TEST_ADDRESS);

    const expectedExplorerUrl = buildTransactionExplorerUrl(VALID_TX_HASH);
    const explorerLink = screen.getByRole('link', { name: /view on explorer/i });
    expect(explorerLink).toHaveAttribute('href', expectedExplorerUrl);
    expect(screen.getByLabelText('Transaction Receipt Details')).toBeInTheDocument();
  });

  it('handles Freighter user rejection distinctly', async () => {
    const user = userEvent.setup();
    mockWalletState({
      status: 'connected',
      address: TEST_ADDRESS,
      networkPassphrase: Networks.TESTNET,
    });

    vi.spyOn(claimTx, 'buildClaimTransaction').mockResolvedValue(MOCK_TX);
    vi.spyOn(claimTx, 'simulateClaimTransaction').mockResolvedValue({
      ok: true,
      preparedTransaction: MOCK_TX,
      minResourceFee: '1000',
      estimatedFeeStroops: '1100',
      estimatedFeeXlm: '0.00011 XLM',
    });
    vi.spyOn(claimTx, 'signClaimTransaction').mockRejectedValue(
      new claimTx.ClaimTransactionError(
        'USER_REJECTED',
        'Transaction signing was rejected in Freighter.',
      ),
    );

    render(<LockupClaimModal isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /claim now/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign & submit/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /sign & submit/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /transaction signing was rejected in freighter/i,
      );
    });
  });

  it('handles polling timeout distinctly', async () => {
    const user = userEvent.setup();
    mockWalletState({
      status: 'connected',
      address: TEST_ADDRESS,
      networkPassphrase: Networks.TESTNET,
    });

    vi.spyOn(claimTx, 'buildClaimTransaction').mockResolvedValue(MOCK_TX);
    vi.spyOn(claimTx, 'simulateClaimTransaction').mockResolvedValue({
      ok: true,
      preparedTransaction: MOCK_TX,
      minResourceFee: '1000',
      estimatedFeeStroops: '1100',
      estimatedFeeXlm: '0.00011 XLM',
    });
    vi.spyOn(claimTx, 'signClaimTransaction').mockResolvedValue({
      signedTxXdr: 'AAAAsigned==',
    });
    vi.spyOn(claimTx, 'submitAndPollClaimTransaction').mockRejectedValue(
      new claimTx.ClaimTransactionError(
        'TIMEOUT',
        'Transaction confirmation timed out while waiting for Stellar Testnet.',
        VALID_TX_HASH,
      ),
    );

    render(<LockupClaimModal isOpen onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /claim now/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign & submit/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /sign & submit/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
    });
  });
});
