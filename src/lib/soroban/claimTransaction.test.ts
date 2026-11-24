import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Account, Keypair, Networks, Transaction, TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { NETWORK_PASSPHRASE, buildTransactionExplorerUrl } from '../../constants/stellar';
import { setRpcServerFactory, resetRpcServerFactory } from './revoraContract';
import {
  ClaimTransactionError,
  buildClaimTransaction,
  formatStroopsToXlm,
  isTestnetNetworkPassphrase,
  signClaimTransaction,
  simulateClaimTransaction,
  submitAndPollClaimTransaction,
  type ClaimPollUpdate,
} from './claimTransaction';

const { assembleTransactionMock, isSimulationErrorMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
  isSimulationErrorMock: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: assembleTransactionMock,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: isSimulationErrorMock,
      },
    },
  };
});

vi.mock('@stellar/freighter-api', () => ({
  signTransaction: vi.fn(),
}));

const TEST_ADDRESS = Keypair.random().publicKey();
const VALID_TX_HASH = 'a'.repeat(64);
const MOCK_TX_XDR = 'AAAAAgAAAABmockXdrPayload==';

function createMockPreparedTx(): Transaction {
  return {
    toXDR: vi.fn().mockReturnValue(MOCK_TX_XDR),
  } as unknown as Transaction;
}

describe('claimTransaction', () => {
  let mockServer: {
    getAccount: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = {
      getAccount: vi.fn().mockResolvedValue(new Account(TEST_ADDRESS, '100')),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    setRpcServerFactory(() => mockServer);
  });

  afterEach(() => {
    resetRpcServerFactory();
    vi.restoreAllMocks();
  });

  describe('formatStroopsToXlm & isTestnetNetworkPassphrase', () => {
    it('formats stroops to XLM accurately', () => {
      expect(formatStroopsToXlm(100)).toBe('0.00001 XLM');
      expect(formatStroopsToXlm('15000000')).toBe('1.5 XLM');
      expect(formatStroopsToXlm(-1)).toBe('0 XLM');
    });

    it('accepts only Stellar Testnet passphrase', () => {
      expect(isTestnetNetworkPassphrase(Networks.TESTNET)).toBe(true);
      expect(isTestnetNetworkPassphrase(Networks.PUBLIC)).toBe(false);
      expect(isTestnetNetworkPassphrase(null)).toBe(false);
      expect(isTestnetNetworkPassphrase(undefined)).toBe(false);
    });
  });

  describe('buildClaimTransaction', () => {
    it('builds a Soroban claim transaction with TransactionBuilder and Contract.call', async () => {
      const tx = await buildClaimTransaction(TEST_ADDRESS, 4);

      expect(mockServer.getAccount).toHaveBeenCalledWith(TEST_ADDRESS);
      expect(tx).toBeInstanceOf(Transaction);
      expect(tx.networkPassphrase).toBe(NETWORK_PASSPHRASE);
      expect(tx.operations).toHaveLength(1);
      expect(tx.operations[0].type).toBe('invokeHostFunction');
    });

    it('rejects invalid address or negative periodId', async () => {
      await expect(buildClaimTransaction('', 1)).rejects.toThrow(/valid Stellar wallet address/i);
      await expect(buildClaimTransaction(TEST_ADDRESS, -1)).rejects.toThrow(/periodId/i);
    });
  });

  describe('simulateClaimTransaction', () => {
    it('returns prepared transaction and fee estimate on successful simulation', async () => {
      const tx = await buildClaimTransaction(TEST_ADDRESS, 2);
      const fakeSim = {
        id: 'sim-1',
        latestLedger: 12345,
        minResourceFee: '25000',
        events: [],
        transactionData: {},
      };
      mockServer.simulateTransaction.mockResolvedValue(fakeSim);
      isSimulationErrorMock.mockReturnValue(false);
      assembleTransactionMock.mockReturnValue({
        build: () => tx,
      } as unknown as ReturnType<typeof rpc.assembleTransaction>);

      const result = await simulateClaimTransaction(tx);

      expect(mockServer.simulateTransaction).toHaveBeenCalledWith(tx);
      expect(assembleTransactionMock).toHaveBeenCalledWith(tx, fakeSim);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.preparedTransaction).toBe(tx);
        expect(result.minResourceFee).toBe('25000');
        expect(result.estimatedFeeStroops).toBe('25100');
        expect(result.estimatedFeeXlm).toBe('0.00251 XLM');
      }
    });

    it('returns structured failure reason when simulation fails', async () => {
      const tx = await buildClaimTransaction(TEST_ADDRESS, 2);
      mockServer.simulateTransaction.mockResolvedValue({
        id: 'sim-err',
        latestLedger: 12345,
        error: 'HostError: Error(Contract, #4) AlreadyClaimed',
      });
      isSimulationErrorMock.mockReturnValue(true);

      const result = await simulateClaimTransaction(tx);

      expect(result).toEqual({
        ok: false,
        error: 'HostError: Error(Contract, #4) AlreadyClaimed',
      });
    });
  });

  describe('signClaimTransaction', () => {
    it('refuses signing on a mismatched network and never calls Freighter', async () => {
      const tx = createMockPreparedTx();

      await expect(
        signClaimTransaction(tx, Networks.PUBLIC, TEST_ADDRESS),
      ).rejects.toMatchObject({
        name: 'ClaimTransactionError',
        code: 'NETWORK_MISMATCH',
      });

      expect(signTransaction).not.toHaveBeenCalled();
    });

    it('signs via Freighter when networkPassphrase matches testnet', async () => {
      const tx = createMockPreparedTx();
      vi.mocked(signTransaction).mockResolvedValue({
        signedTxXdr: MOCK_TX_XDR,
        signerAddress: TEST_ADDRESS,
      });

      const result = await signClaimTransaction(tx, Networks.TESTNET, TEST_ADDRESS);

      expect(signTransaction).toHaveBeenCalledWith(MOCK_TX_XDR, {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: TEST_ADDRESS,
      });
      expect(result).toEqual({ signedTxXdr: MOCK_TX_XDR });
    });

    it('maps Freighter user rejection to USER_REJECTED', async () => {
      const tx = createMockPreparedTx();
      vi.mocked(signTransaction).mockResolvedValue({
        signedTxXdr: '',
        signerAddress: '',
        error: { message: 'User declined access' } as unknown as string,
      });

      await expect(
        signClaimTransaction(tx, Networks.TESTNET, TEST_ADDRESS),
      ).rejects.toMatchObject({
        code: 'USER_REJECTED',
      });
    });

    it('maps Freighter signing timeout to TIMEOUT', async () => {
      const tx = createMockPreparedTx();
      vi.mocked(signTransaction).mockImplementation(
        () => new Promise(() => undefined),
      );

      await expect(
        signClaimTransaction(tx, Networks.TESTNET, TEST_ADDRESS, { timeoutMs: 20 }),
      ).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
    });
  });

  describe('submitAndPollClaimTransaction', () => {
    beforeEach(() => {
      vi.spyOn(TransactionBuilder, 'fromXDR').mockReturnValue(createMockPreparedTx());
    });

    it('submits, polls NOT_FOUND then SUCCESS, and returns explorer URL', async () => {
      const updates: ClaimPollUpdate[] = [];

      mockServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: VALID_TX_HASH,
      });
      mockServer.getTransaction
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 987654 });

      const result = await submitAndPollClaimTransaction(MOCK_TX_XDR, {
        onStatus: (u) => updates.push(u),
        pollIntervalMs: 1,
        maxAttempts: 5,
      });

      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
      expect(mockServer.getTransaction).toHaveBeenCalledTimes(2);
      expect(updates).toEqual([
        { status: 'SUBMITTED', hash: VALID_TX_HASH },
        { status: 'NOT_FOUND', hash: VALID_TX_HASH, attempt: 1 },
        { status: 'SUCCESS', hash: VALID_TX_HASH, attempt: 2, ledger: 987654 },
      ]);
      expect(result).toEqual({
        status: 'SUCCESS',
        hash: VALID_TX_HASH,
        ledger: 987654,
        explorerUrl: buildTransactionExplorerUrl(VALID_TX_HASH),
      });
    });

    it('throws TX_FAILED when getTransaction returns FAILED', async () => {
      mockServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: VALID_TX_HASH,
      });
      mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });

      await expect(
        submitAndPollClaimTransaction(MOCK_TX_XDR, { pollIntervalMs: 1, maxAttempts: 3 }),
      ).rejects.toThrow(ClaimTransactionError);

      await expect(
        submitAndPollClaimTransaction(MOCK_TX_XDR, { pollIntervalMs: 1, maxAttempts: 3 }),
      ).rejects.toMatchObject({ code: 'TX_FAILED', txHash: VALID_TX_HASH });
    });

    it('throws SUBMIT_FAILED when sendTransaction returns ERROR', async () => {
      mockServer.sendTransaction.mockResolvedValue({
        status: 'ERROR',
        hash: VALID_TX_HASH,
      });

      await expect(
        submitAndPollClaimTransaction(MOCK_TX_XDR, { pollIntervalMs: 1 }),
      ).rejects.toMatchObject({ code: 'SUBMIT_FAILED' });
    });

    it('throws TIMEOUT when polling exceeds maxAttempts', async () => {
      mockServer.sendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: VALID_TX_HASH,
      });
      mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

      await expect(
        submitAndPollClaimTransaction(MOCK_TX_XDR, { pollIntervalMs: 1, maxAttempts: 2 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT', txHash: VALID_TX_HASH });
    });
  });
});
