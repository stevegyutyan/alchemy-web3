import { fromHex, toHex } from "../util/hex";
import { BatchPart, JsonRpcSenders } from "../util/jsonRpc";

export interface NewHeadsEvent {
  author: string;
  difficulty: string;
  extraData: string;
  gasLimit: string;
  gasUsed: string;
  hash: string;
  logsBloom: string;
  miner: string;
  mixHash: string;
  nonce: string;
  number: string;
  parentHash: string;
  receiptsRoot: string;
  sealFields: string[];
  sha3Uncles: string;
  size: string;
  stateRoot: string;
  timestamp: string;
  transactionsRoot: string;
}

/**
 * The return type of eth_getBlocksByHash.
 */
export interface BlockHead extends NewHeadsEvent {
  totalDifficulty: string;
  transactions: any[];
  uncles: string[];
}

export interface LogsEvent {
  address: string;
  blockHash: string;
  blockNumber: string;
  data: string;
  logIndex: string;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
  removed?: boolean;
}

export interface LogsSubscriptionFilter {
  address?: string | string[];
  topics?: Array<string | string[] | null>;
}

interface GetLogsOptions extends LogsSubscriptionFilter {
  fromBlock?: string;
  toBlock?: string;
}

export type Backfiller = ReturnType<typeof makeBackfiller>;

/**
 * The maximum number of blocks to backfill. If more than this many blocks have
 * been missed, then we'll sadly miss data, but we want to make sure we don't
 * end up requesting thousands of blocks if somebody left their laptop closed
 * for a week.
 */
const MAX_BACKFILL_BLOCKS = 120;

export function makeBackfiller(senders: JsonRpcSenders) {
  return { getNewHeadsBackfill, getLogsBackfill };

  async function getNewHeadsBackfill(
    previousHeads: NewHeadsEvent[],
    fromBlockNumber: number,
    toBlockNumber: number,
  ): Promise<NewHeadsEvent[]> {
    if (previousHeads.length === 0) {
      return getHeadEventsInRange(
        Math.max(fromBlockNumber, toBlockNumber - MAX_BACKFILL_BLOCKS) + 1,
        toBlockNumber + 1,
      );
    }
    const lastSeenBlockNumber = fromHex(
      previousHeads[previousHeads.length - 1].number,
    );
    const minBlockNumber = Math.max(
      0,
      lastSeenBlockNumber - MAX_BACKFILL_BLOCKS,
    );
    if (lastSeenBlockNumber < minBlockNumber) {
      return getHeadEventsInRange(minBlockNumber, toBlockNumber + 1);
    }
    const reorgHeads: NewHeadsEvent[] = await getReorgHeads(previousHeads);
    const intermediateHeads: NewHeadsEvent[] = await getHeadEventsInRange(
      lastSeenBlockNumber + 1,
      toBlockNumber + 1,
    );
    return [...reorgHeads, ...intermediateHeads];
  }

  async function getReorgHeads(
    previousHeads: NewHeadsEvent[],
  ): Promise<NewHeadsEvent[]> {
    const result: NewHeadsEvent[] = [];
    for (let i = previousHeads.length - 1; i >= 0; i--) {
      const oldEvent = previousHeads[i];
      const blockHead = await getBlockByNumber(fromHex(oldEvent.number));
      if (oldEvent.hash === blockHead.hash) {
        break;
      }
      result.push(toNewHeadsEvent(blockHead));
    }
    return result.reverse();
  }

  async function getHeadEventsInRange(
    fromBlockInclusive: number,
    toBlockExclusive: number,
  ): Promise<NewHeadsEvent[]> {
    const batchParts: BatchPart[] = [];
    for (let i = fromBlockInclusive; i < toBlockExclusive; i++) {
      batchParts.push({
        method: "eth_getBlockByNumber",
        params: [toHex(i), false],
      });
    }
    const heads = await senders.sendBatch(batchParts);
    return heads.map(toNewHeadsEvent);
  }

  async function getBlockByNumber(blockNumber: number): Promise<BlockHead> {
    return senders.send("eth_getBlockByNumber", [toHex(blockNumber), false]);
  }

  async function getLogsBackfill(
    filter: LogsSubscriptionFilter,
    previousLogs: LogsEvent[],
    fromBlockNumber: number,
    toBlockNumber: number,
  ): Promise<LogsEvent[]> {
    if (previousLogs.length === 0) {
      return getLogsInRange(
        filter,
        Math.max(fromBlockNumber, toBlockNumber - MAX_BACKFILL_BLOCKS) + 1,
        toBlockNumber + 1,
      );
    }
    const lastSeenBlockNumber = fromHex(
      previousLogs[previousLogs.length - 1].blockNumber,
    );
    const minBlockNumber = Math.max(
      0,
      lastSeenBlockNumber - MAX_BACKFILL_BLOCKS,
    );
    if (lastSeenBlockNumber < minBlockNumber) {
      return getLogsInRange(filter, minBlockNumber, toBlockNumber + 1);
    }
    const commonAncestorNumber = await getCommonAncestorNumber(previousLogs);
    const removedLogs = previousLogs
      .filter(log => fromHex(log.blockNumber) > commonAncestorNumber)
      .map(log => ({ ...log, removed: true }));
    const addedLogs = await getLogsInRange(
      filter,
      commonAncestorNumber + 1,
      toBlockNumber + 1,
    );
    return [...removedLogs, ...addedLogs];
  }

  async function getCommonAncestorNumber(
    previousLogs: LogsEvent[],
  ): Promise<number> {
    for (let i = previousLogs.length - 1; i >= 0; i--) {
      const { blockHash, blockNumber } = previousLogs[i];
      const { hash } = await getBlockByNumber(fromHex(blockNumber));
      if (blockHash === hash) {
        return fromHex(blockNumber);
      }
    }
    return Number.NEGATIVE_INFINITY;
  }

  function getLogsInRange(
    filter: LogsSubscriptionFilter,
    fromBlockInclusive: number,
    toBlockExclusive: number,
  ): Promise<LogsEvent[]> {
    const rangeFilter: GetLogsOptions = {
      ...filter,
      fromBlock: toHex(fromBlockInclusive),
      toBlock: toHex(toBlockExclusive - 1),
    };
    return senders.send("eth_getLogs", [rangeFilter]);
  }
}

function toNewHeadsEvent(head: BlockHead): NewHeadsEvent {
  const result = { ...head };
  delete result.totalDifficulty;
  delete result.transactions;
  delete result.uncles;
  return result;
}

export function dedupeNewHeads(events: NewHeadsEvent[]): NewHeadsEvent[] {
  return dedupe(events, event => event.hash);
}

export function dedupeLogs(events: LogsEvent[]): LogsEvent[] {
  return dedupe(events, event => `${event.blockHash}/${event.logIndex}`);
}

function dedupe<T>(items: T[], getKey: (item: T) => any): T[] {
  const keysSeen: Set<any> = new Set();
  const result: T[] = [];
  items.forEach(item => {
    const key = getKey(item);
    if (!keysSeen.has(key)) {
      keysSeen.add(key);
      result.push(item);
    }
  });
  return result;
}
