// deno-lint-ignore-file camelcase

import { ImmSet } from "./deps.ts";

import type { U256, U64 } from "./lib/numbers/mod.ts";
import { bits_mask, u16, u256, u64 } from "./lib/numbers/mod.ts";
import type { Heap } from "./lib/heap.ts";
import * as heap from "./lib/heap.ts";
import { get_dir_with_base } from "./lib/files.ts";
import type { AddressOptPort } from "./lib/address.ts";

import type { Hash, HashMap } from "./types/hash.ts";
import * as hash from "./types/hash.ts";
import type { Block, BlockBody, Chain, PowSlice, Slice } from "./types/blockchain.ts";
import type { AddressPort, Message, Peer } from "./types/networking.ts";

import {
  deserialize_block,
  serialize_address,
  serialize_block,
  serialize_body,
  serialize_pow_slice,
  bits_to_uint8array,
  serialize_bits_to_uint8array,
  deserialize_bits_from_uint8array,
} from "./serialization.ts";

import { udp_init, udp_send, udp_receive } from "./networking.ts"
import { keccak256 } from "./keccak256.ts";
import { pad_left } from "./util.ts";

// Files
// =====

// Configuration:
// ~/.ubilog/config
// Output:
// ~/.ubilog/data/blocks/HASH
// ~/.ubilog/data/mined/HASH

// Constants
// =========

import {
  BLOCKS_PER_PERIOD,
  BODY_SIZE,
  DEFAULT_PORT,
  DELAY_TOLERANCE,
  DIR_BLOCKS,
  DIR_MINED,
  INITIAL_DIFFICULTY,
  TIME_PER_BLOCK,
  TIME_PER_PERIOD,
} from "./constants.ts";

// export const EMPTY_BODY: BlockBody = new Uint8Array(BODY_SIZE) as BlockBody;
export const EMPTY_BODY: BlockBody = [];

export const BLOCK_ZERO: Block = {
  prev: hash.zero,
  time: u256.zero,
  body: EMPTY_BODY,
};

const DEFAULT_SCORE = (slice: PowSlice) => get_hash_work(hash_pow_slice(slice));

// Types
// =====

type Dict<T> = Record<string, T>;

type Nat = bigint; // TODO: tagged type

// Network
// -------

type Node = {
  port: number; // TODO: U16
  peers: Dict<Peer>;
  chain: Chain;
};

// Algorithms
// ==========

const HASH = hash.assert;

// Util

function assert_non_null<T>(value: T | null | undefined): asserts value is T {
  if (value == null) {
    throw "FAILURE: null or undefined value";
  }
}

type Gettable<K, T> = { get: (k: K) => T | undefined };
function get_assert<K, T>(m: Gettable<K, T>, k: K): T {
  const v = m.get(k);
  assert_non_null(v);
  return v;
}

function now(): bigint {
  return BigInt(Date.now());
}

// Numbers
// -------

const MASK_64: bigint = bits_mask(64n);
const MASK_192: bigint = bits_mask(192n);

function next_power_of_two(x: number): number {
  return x <= 1 ? x : 2 ** (Math.floor(Math.log(x - 1) / Math.log(2)) + 1);
}

// Hashing
// -------

function u256_to_uint8array(value: U256): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < 32; ++i) {
    bytes.push(Number((value >> BigInt((32 - i - 1) * 8)) % 0x100n));
  }
  return new Uint8Array(bytes);
}

function hash_to_uint8array(hash: Hash): Uint8Array {
  return u256_to_uint8array(u256.mask(BigInt(hash)));
}

function body_to_uint8array(body: BlockBody): Uint8Array {
  const bits = serialize_body(body);
  return bits_to_uint8array(bits);
}

function compute_difficulty(target: Nat): Nat {
  return 2n ** 256n / (2n ** 256n - target);
}

function compute_target(difficulty: Nat): Nat {
  return 2n ** 256n - 2n ** 256n / difficulty;
}

// Computes next target by scaling the current difficulty by a `scale` factor
// Since the factor is an integer, it is divided by 2^32 to allow integer division
// - compute_next_target(t, 2n**32n / 2n): difficulty halves
// - compute_next_target(t, 2n**32n * 1n): nothing changes
// - compute_next_target(t, 2n**32n * 2n): difficulty doubles
function compute_next_target(last_target: Nat, scale: Nat): Nat {
  const last_difficulty = compute_difficulty(last_target);
  const next_difficulty = 1n + (last_difficulty * scale - 1n) / 2n ** 32n;
  return compute_target(next_difficulty);
}

function get_hash_work(hash: Hash): Nat {
  const value = BigInt(HASH(hash));
  if (value === 0n) {
    return 0n;
  } else {
    return compute_difficulty(value);
  }
}

function hash_uint8array(words: Uint8Array): Hash {
  return HASH(keccak256(Array.from(words)));
}

function hash_block(block: Block): Hash {
  if (block.prev === hash.zero && block.time === 0n) {
    return hash.zero;
  } else {
    return hash_uint8array(
      new Uint8Array([
        ...hash_to_uint8array(block.prev),
        ...u256_to_uint8array(block.time),
        ...body_to_uint8array(block.body),
      ]),
    );
  }
}

// function hash_slice(slice: Slice): Hash {
//   return hash_uint8array(bits_to_uint8array(slice));
// }

function hash_pow_slice(pow_slice: PowSlice): Hash {
  return hash_uint8array(bits_to_uint8array(serialize_pow_slice(pow_slice)));
}

// Attempts to mine a block by changing the least significant 192 bits of its
// time until its hash is larger than a target, up to an maximum number of
// attempts. Returns the time-adjusted block if it works, or null if it fails.
// If a secret_key is provided, the low bits are set as:
//   bits : U192 = keccak256(key_192 | rand_64)[0..192]
// This allows the miner to prove himself as the block miner by revealing a
// 192-bit key, plus the random number used to generate the low bits.
function mine(
  block: Block,
  target: Nat,
  max_attempts: number,
  node_time: U64,
  secret_key: U256 = u256.zero,
): [Block, U64] | null {
  for (let i = 0n; i < max_attempts; ++i) {
    const [rand_0, rand_1] = crypto.getRandomValues(new Uint32Array(2));
    const rand = u64.mask(BigInt(rand_0) | (BigInt(rand_1) << 32n));
    const nonce = (secret_key << 64n) | rand;
    const bits = BigInt(hash_uint8array(u256_to_uint8array(u256.mask(nonce)))) & MASK_192;
    const time = u256.mask(((node_time & MASK_64) << 192n) | bits);
    block = { ...block, time };
    const hash = hash_block(block);
    if (BigInt(hash) > target) {
      return [block, rand];
    }
  }
  return null;
}

// Chain
// -----

// initial target of 256 hashes per block
const INITIAL_TARGET: Nat = compute_target(INITIAL_DIFFICULTY);

function initial_chain(): Chain {
  const block: HashMap<Block> = new Map([[hash.zero, BLOCK_ZERO]]);
  const children: HashMap<Array<Hash>> = new Map([[hash.zero, []]]);
  const pending: HashMap<Array<Block>> = new Map();
  const work: HashMap<U64> = new Map([[hash.zero, u64.zero]]);
  const height: HashMap<Nat> = new Map([[hash.zero, 0n]]);
  const target: HashMap<Nat> = new Map([[hash.zero, INITIAL_TARGET]]);
  const mined_slices: HashMap<ImmSet<Slice>> = new Map([[hash.zero, ImmSet()]]);
  const seen: HashMap<true> = new Map();
  const tip: [U64, Hash] = [u64.zero, hash.zero];
  return { block, children, pending, work, height, target, seen, tip, mined_slices };
}

function handle_block(chain: Chain, block: Block, time: U64): { tip_was_updated: boolean } {
  let tip_was_updated = false;
  const must_add: Block[] = [block];
  while (must_add.length > 0) {
    const block = must_add.pop() ?? BLOCK_ZERO;
    const b_time = block.time >> 192n;
    if (b_time < BigInt(time) + DELAY_TOLERANCE) {
      // Block has valid time
      const { pending, tip_was_updated: tip_upd } = add_block(chain, block);
      tip_was_updated ||= tip_upd;
      // Add all blocks that were waiting for this block
      for (const p of pending) {
        must_add.push(p);
      }
    }
  }
  return { tip_was_updated };
}

function add_block(chain: Chain, block: Block): { pending: Block[]; tip_was_updated: boolean } {
  let pending: Block[] = [];
  let tip_was_updated = false;

  const b_hash = hash_block(block);
  if (chain.block.get(b_hash) !== undefined) {
    // Block is already present in the database
    return { pending, tip_was_updated };
  }

  const prev_hash = block.prev;
  // If previous block is not available
  if (chain.block.get(prev_hash) === undefined) {
    // And this block was not been seen before
    if (chain.seen.get(b_hash) === undefined) {
      // Add this block to the previous block's pending list
      console.log(" ^^ pending block".padEnd(30, " "), b_hash); // DEBUG
      chain.pending.set(prev_hash, chain.pending.get(prev_hash) ?? []);
      get_assert(chain.pending, prev_hash).push(block);
    }
  } // If previous block is available, add the block
  else {
    console.log("  ++ adding block".padEnd(30, " "), b_hash); // DEBUG
    // TODO: ??
    chain.block.set(b_hash, block);
    chain.work.set(b_hash, 0n);
    chain.height.set(b_hash, 0n);
    chain.target.set(b_hash, 0n);
    chain.children.set(b_hash, []);
    const prev_mined_slices = get_assert(chain.mined_slices, prev_hash);
    const b_mined_slices = prev_mined_slices.withMutations((s) => {
      for (const slice of block.body) {
        s.add(slice);
      }
    });
    chain.mined_slices.set(b_hash, b_mined_slices);
    // console.log(b_mined_slices); // DEBUG

    const prev_block = get_assert(chain.block, prev_hash);
    const prev_target = get_assert(chain.target, prev_hash);
    const has_enough_work = BigInt(b_hash) >= prev_target;
    const b_time = block.time >> 192n;
    const prev_time = prev_block.time >> 192n;
    const advances_time = b_time > prev_time;
    // If the block is valid
    if (has_enough_work && advances_time) {
      const prev_work = get_assert(chain.work, prev_hash);
      const work = get_hash_work(b_hash);
      chain.work.set(b_hash, prev_work + work);
      if (prev_hash !== hash.zero) {
        const prev_height = get_assert(chain.height, prev_hash);
        chain.height.set(b_hash, prev_height + 1n);
      }
      const b_height = get_assert(chain.height, b_hash);
      if (!(b_height > 0n && b_height % BLOCKS_PER_PERIOD === 0n)) {
        // Keep old difficulty
        chain.target.set(b_hash, get_assert(chain.target, prev_hash));
      } else {
        // Update difficulty
        let checkpoint_hash = prev_hash;
        for (let i = 0n; i < BLOCKS_PER_PERIOD - 1n; ++i) {
          checkpoint_hash = get_assert(chain.block, checkpoint_hash).prev;
        }
        const period_time = Number(
          b_time - (get_assert(chain.block, checkpoint_hash).time >> 192n),
        );
        const last_target = get_assert(chain.target, prev_hash);
        const scale = BigInt(
          Math.floor((2 ** 32 * Number(TIME_PER_PERIOD)) / period_time),
        );
        const next_target = compute_next_target(last_target, scale);
        chain.target.set(b_hash, next_target);
        // console.log();
        // console.log("[DIFF] A period should last   " + TIME_PER_PERIOD + " seconds.");
        // console.log("[DIFF] the last period lasted " + period_time + " seconds.");
        // console.log("[DIFF] the last difficulty was " + compute_difficulty(last_target) + " hashes per block.");
        // console.log("[DIFF] the next difficulty is  " + compute_difficulty(next_target) + " hashes per block.");
        // console.log();
      }
      // Refresh tip
      if (get_assert(chain.work, b_hash) > chain.tip[0]) {
        chain.tip = [u64.mask(get_assert(chain.work, b_hash)), b_hash];
        tip_was_updated = true;
      }
    }
    // Registers this block as a child
    get_assert(chain.children, prev_hash).push(b_hash);
    // Returns all blocks that were waiting for this block
    pending = chain.pending.get(b_hash) ?? [];
    chain.pending.delete(b_hash);
  }
  chain.seen.set(b_hash, true);
  return { pending, tip_was_updated };
}

function get_longest_chain(chain: Chain): Array<Block> {
  const longest = [];
  let b_hash = chain.tip[1];
  while (true) {
    const block = chain.block.get(b_hash);
    if (block == undefined || b_hash === hash.zero) {
      break;
    }
    longest.push(block);
    b_hash = block.prev;
  }
  return longest.reverse();
}

// Stringification
// ---------------

function show_block(chain: Chain, block: Block, index: number) {
  const b_hash = hash_block(block);
  const work = chain.work.get(b_hash) ?? 0n;
  const show_index = BigInt(index).toString();
  const show_time = (block.time >> 192n).toString(10);
  // const show_body = [].slice
  //   .call(block.body, 0, 32)
  //   .map((x: number) => pad_left(2, "0", x.toString(16)))
  //   .join("");
  const show_hash = b_hash;
  const show_work = work.toString();
  const show_body = block.body.join(", ");
  return (
    "" +
    pad_left(8, " ", show_index) +
    " | " +
    pad_left(13, "0", show_time) +
    " | " +
    pad_left(64, "0", show_hash) +
    " | " +
    pad_left(16, "0", show_work) +
    " | " +
    // pad_left(64, " ", show_body) +
    show_body +
    // " | " +
    ""
  );
}

function show_chain(chain: Chain, lines: number) {
  // const count = Math.floor(lines / 2);
  const blocks = get_longest_chain(chain);
  const lim = next_power_of_two(blocks.length);
  const add = lim > lines ? lim / lines : 1;
  const pad_s = (x: number) => (txt: string) => pad_left(x, " ", txt);
  let text = `${pad_s(8)("#")} | ${pad_s(13)("time")} | ${pad_s(64)("hash")} | ${
    pad_s(16)("work")
  } | ${pad_s(64)("body")} \n`;
  // "       # | time          | hash                                                             | head                                                             | work\n";
  for (let i = 0; i < blocks.length - 1; i += add) {
    text += show_block(chain, blocks[i], i) + "\n";
  }
  if (blocks.length > 1) {
    text += show_block(chain, blocks[blocks.length - 1], blocks.length - 1) + "\n";
  }
  return text;
}

// Networking
// ----------

// Node
// ----

const CONFIG_DEFAULTS = {
  port: DEFAULT_PORT,
  display: false,
  mine: false,
  secret_key: u256.zero,
  peers: [] as AddressOptPort[],
};

export function start_node(
  base_dir: string,
  config: Partial<typeof CONFIG_DEFAULTS>,
) {
  const get_dir = get_dir_with_base(base_dir);
  const cfg = Object.assign({}, CONFIG_DEFAULTS, config);

  // const MINER_CPS = 16;
  // const MINER_HASHRATE = 64;

  const initial_peers: Dict<Peer> = {};
  for (const cfg_peer of cfg.peers) {
    const port = u16.mask(cfg_peer.port ?? DEFAULT_PORT);
    const address = { ...cfg_peer, port };
    const peer = { seen_at: now(), address };
    initial_peers[serialize_address(address)] = peer;
  }

  // ----------
  // Node state

  const chain: Chain = initial_chain();
  const node: Node = {
    port: cfg.port,
    peers: initial_peers,
    chain: chain,
    // pool: heap.empty,
  };

  let slices_pool: Heap<Slice> = heap.empty;
  let next_block_body: BlockBody = EMPTY_BODY;
  // next_block_body.push(
  //   serialize_fixed_len(16, BigInt(cfg.port)),
  // );
  let MINED = 0;

  // ----------

  // Initializes sockets
  const udp = udp_init(cfg.port);

  // Returns the current time
  // TODO: get peers median?
  function get_time(): U64 {
    return u64.mask(now());
  }

  function send(to: AddressPort, message: Message) {
    udp_send(udp, to, message);
  }

  function all_peers(): Array<Peer> {
    return Object.values(node.peers);
  }

  function handle_slice(pow_slice: PowSlice) {
    const score = DEFAULT_SCORE(pow_slice);
    slices_pool = heap.insert(slices_pool, [score, pow_slice.data]);
  }

  const MAX_BODY_BITS = BODY_SIZE * 8;
  function build_next_block_body() {
    // One bit for the end of the list serialization
    let bits_len = 1;
    const chosen = [];
    const ignored = [];

    const tip_hash = chain.tip[1];
    const mined = get_assert(chain.mined_slices, tip_hash);

    let head: [bigint, Slice] | null;
    while (head = heap.head(slices_pool), head !== null) {
      const [_score, slice] = head;
      if (mined.has(slice)) {
        // TODO: FIX: not ignoring already mined slices
        // This slice is already on the longest chain
        // Pop and ignore it
        slices_pool = heap.tail(slices_pool);
        ignored.push(slice);
      } else {
        // One bit for each item on list serialization, plus the item length
        const item_bits_len = slice.length + 1;
        if (bits_len + item_bits_len > MAX_BODY_BITS) {
          // This slice doesn't fit in the body.
          break;
        }
        bits_len += item_bits_len;
        slices_pool = heap.tail(slices_pool);
        chosen.push(slice);
      }
    }
    next_block_body = chosen;
  }

  // Handles incoming messages
  function handle_message(sender: AddressPort, message: Message) {
    switch (message.ctor) {
      case "PutPeers": {
        console.log(
          "<- received PutPeers".padEnd(30, " "),
          message.peers.length,
        ); // DEBUG
        for (const address of message.peers) {
          node.peers[serialize_address(address)] = {
            seen_at: get_time(),
            address,
          };
        }
        return;
      }
      case "PutBlock": {
        // console.log(
        //   "<- received PutBlock".padEnd(30, " "),
        //   hash_block(message.block),
        // ); // DEBUG
        const { tip_was_updated } = handle_block(node.chain, message.block, get_time());
        if (cfg.mine && tip_was_updated) {
          build_next_block_body();
        }
        return;
      }
      case "AskBlock": {
        // console.log("<- received AskBlock".padEnd(30, " "), message.b_hash); // DEBUG
        const block = node.chain.block.get(message.b_hash);
        if (block) {
          // console.log(`  -> sending asked block:`.padEnd(30, " "), `${message.b_hash}`); // DEBUG
          send(sender, { ctor: "PutBlock", block });
          // Gets some children to send too
          // for (var i = 0; i < 8; ++i) {
          //  var block = node.chain.block[block.prev];
          //  if (block) {
          //    send(sender, {ctor: "PutBlock", block});
          //  }
          // }
        } else {
          // console.log(`  XX block not found:`.padEnd(30, " "), `${message.b_hash}`); // DEBUG
        }
        return;
      }
      case "PutSlice": {
        console.log("<- received PutSlice".padEnd(30, " ")); // DEBUG
        handle_slice(message.slice);
        return;
      }
    }
  }

  function write_block(block: Block, rand: U64) {
    const b_hash = hash_block(block);
    const dir = get_dir(DIR_MINED);
    const rand_txt = pad_left((64 / 8) * 2, "0", rand.toString(16));
    // TODO: one JSONL file per secret_key
    Deno.writeTextFileSync(dir + "/" + b_hash, rand_txt);
  }

  // Attempts to mine new blocks
  function miner() {
    const tip_hash = node.chain.tip[1];
    const tip_target = node.chain.target.get(tip_hash);
    assert_non_null(tip_target);
    // const max_hashes = MINER_HASHRATE / MINER_CPS;
    const max_hashes = 16;
    const mined = mine(
      { ...BLOCK_ZERO, body: next_block_body, prev: tip_hash },
      tip_target,
      max_hashes,
      get_time(),
      cfg.secret_key,
    );
    //console.log("[miner] Difficulty: " + compute_difficulty(tip_target) + " hashes/block. Power: " + max_hashes + " hashes.");
    if (mined != null) {
      console.log("=> block MINED".padEnd(30, " "));
      const [new_block, rand] = mined;
      MINED += 1;
      handle_block(node.chain, new_block, get_time());
      write_block(new_block, rand);
    }
    // Let other jobs run and loop
    // await null;
    setTimeout(miner, 0);
  }

  // Sends our tip block to random peers
  function gossiper() {
    const tip_hash = node.chain.tip[1];
    const block = get_assert(node.chain.block, tip_hash);
    console.log("=> sending TIP".padEnd(30, " "), hash_block(block)); // DEBUG
    for (const peer of all_peers()) {
      send(peer.address, { ctor: "PutBlock", block });
    }
  }

  // Requests missing blocks
  function requester() {
    for (const b_hash of node.chain.pending.keys()) {
      if (!node.chain.seen.get(b_hash)) {
        console.log("=> requesting PENDING".padEnd(30, " "), b_hash); // DEBUG
        for (const peer of all_peers()) {
          send(peer.address, { ctor: "AskBlock", b_hash });
        }
      }
    }
  }

  // Saves longest chain
  function saver() {
    const chain = get_longest_chain(node.chain);
    for (let i = 0; i < chain.length; ++i) {
      const bits = serialize_block(chain[i]);
      const buff = serialize_bits_to_uint8array(bits);
      const indx = pad_left(16, "0", i.toString(16));
      const b_dir = get_dir(DIR_BLOCKS);
      Deno.writeFileSync(b_dir + "/" + indx, buff);
    }
  }

  // Loads saved blocks
  function loader() {
    const b_dir = get_dir(DIR_BLOCKS);
    const files = Array.from(Deno.readDirSync(b_dir)).sort((x, y) => x.name > y.name ? 1 : -1);
    for (const file of files) {
      const buff = Deno.readFileSync(b_dir + "/" + file.name);
      const [_bits, block] = deserialize_block(deserialize_bits_from_uint8array(buff));
      handle_block(node.chain, block, get_time());
    }
  }

  // Displays status
  function displayer() {
    const tip_hash = node.chain.tip[1];
    const tip_target = get_assert(node.chain.target, tip_hash);
    const diff = compute_difficulty(tip_target);
    const rate = (diff * 1000n) / TIME_PER_BLOCK;
    const pending = node.chain.pending;
    let pending_size = 0;
    let pending_seen = 0;
    for (const b_hash of pending.keys()) {
      if (node.chain.seen.get(b_hash)) {
        pending_seen += 1;
      }
      pending_size += 1;
    }
    console.clear();
    console.log("Ubilog");
    console.log("======");
    console.log("");
    console.log("- current_time  : " + get_time() + " UTC");
    console.log(
      "- online_peers  : " + Object.keys(node.peers).length + " peers",
    );
    console.log(
      "- chain_height  : " + get_longest_chain(node.chain).length + " blocks",
    );
    console.log("- database      : " + (node.chain.block.size - 1) + " blocks");
    console.log(
      "- pending       : " +
        pending_size +
        " blocks (" +
        pending_seen +
        " downloaded)",
    );
    console.log("- total_mined   : " + MINED + " blocks");
    // console.log("- own_hash_rate : " + MINER_HASHRATE + " hashes / second");
    console.log("- net_hash_rate : " + rate + " hashes / second");
    console.log("- difficulty    : " + diff + " hashes / block");
    console.log(
      "- peers: ",
      all_peers()
        .map((p) => JSON.stringify(p.address))
        .join(", "),
    );
    console.log("");
    console.log("Blocks");
    console.log("------");
    console.log("");
    console.log(show_chain(node.chain, 16));
    console.log();
  }

  // function display_tip() {
  //   const tip = chain.tip;
  //   const tip_hash = tip[1];
  //   // const tip_block = get_assert(chain.block, tip_hash);
  //   const tip_height = get_assert(chain.height, tip_hash);
  //   console.log(tip_height, "->", tip_hash);
  // }

  loader();

  const receiver = () => udp_receive(udp, DEFAULT_PORT, handle_message);

  setInterval(gossiper, 1000);
  setInterval(requester, 1000 / 32);
  setInterval(receiver, 1000 / 64);
  setInterval(saver, 1000 * 30);

  if (cfg.mine) {
    // setInterval(miner, 1000 / MINER_CPS);
    build_next_block_body();
    miner();
  }
  if (cfg.display) {
    setTimeout(
      () => setInterval(displayer, 1000), //
      900,
    );
  }
}

//function test_0() {
//  const target = compute_target(1000n);
//  const max_attempts = 999999;
//  const do_mine = (prev: Hash) =>
//    mine({ ...BlockZero, prev }, target, max_attempts, BigInt(Date.now())) ??
//    BlockZero;
//  const block_0 = do_mine(hash.zero);
//  const block_1 = do_mine(hash_block(block_0));
//  const block_2 = do_mine(hash_block(block_1));
//
//  const chain = initial_chain();
//  add_block(chain, block_0, BigInt(Date.now()));
//  add_block(chain, block_1, BigInt(Date.now()));
//  add_block(chain, block_2, BigInt(Date.now()));
//  console.log(show_chain(chain, 8));
//
//  console.log(serialize_block(block_2));
//}
//test_0();

// function err(x: string) {
//   console.error(`ERROR: ${x}`);
// }

// function show_usage() {
//   console.log(`Usage:  ubilog-ts [--port PORT]`);
// }

// function err_usage_exit(x: string): never {
//   err(x);
//   show_usage();
//   Deno.exit(1);
// }
