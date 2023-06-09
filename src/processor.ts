import { TypeormDatabase } from "@subsquid/typeorm-store";
import { EvmBatchProcessor } from "@subsquid/evm-processor";
import {
  CORE_PROXY_ADDRESS,
  METAFORCE_PROXY_ADDRESS,
  ROOT_ID,
} from "./constants";
import * as core from "./abi/core";
import * as metaForce from "./abi/meta-force";
import {
  Event,
  LostMoney,
  MarketingReferrerChanged,
  Pack,
  RevenueMFS,
  RevenueStable,
  TimestampEndPack,
  User,
} from "./model";
import { EntityManager } from "typeorm";
import { BigNumber } from "ethers";
import { lookupArchive } from "@subsquid/archive-registry";

const database = new TypeormDatabase();
const processor = new EvmBatchProcessor()
  // Contracts deployment block
  .setBlockRange({ from: 31461665 })
  .setDataSource({
    // uncomment and set RPC_ENDPOONT to enable contract state queries.
    // Both https and wss endpoints are supported.
    // chain: process.env.RPC_ENDPOINT,

    // Change the Archive endpoints for run the squid
    // against the other EVM networks
    // For a full list of supported networks and config options
    // see https://docs.subsquid.io/develop-a-squid/evm-processor/configuration/

    archive: lookupArchive("polygon-mumbai") || "https://polygon-mumbai.archive.subsquid.io",
  })
  .addLog(CORE_PROXY_ADDRESS, {
    filter: [
      [
        core.events.MarketingReferrerChanged.topic,
        core.events.TimestampEndPackSet.topic,
      ],
    ],
    data: {
      evmLog: {
        topics: true,
        data: true,
      },
      transaction: {
        hash: true,
      },
    },
  })
  .addLog(METAFORCE_PROXY_ADDRESS, {
    filter: [
      [
        metaForce.events.RevenueMFS.topic,
        metaForce.events.RevenueStable.topic,
        metaForce.events.LostMoney.topic,
      ],
    ],
    data: {
      evmLog: {
        topics: true,
        data: true,
      },
      transaction: {
        hash: true,
      },
    },
  });

processor.run(database, async (ctx) => {

  /**
   * @notice function for find or create (if not exists) entity in DB
   * @doc https://docs.subsquid.io/tutorials/create-an-ethereum-processing-squid/#managing-the-evm-contract
   * @argument id user ID in MetaForce
   * @returns User TypeORM entity from model
  */
  async function findOrCreateUser(id: string): Promise<User> {
    const mgr: EntityManager = await ctx.store["em"]();
    const repository = mgr.getTreeRepository(User);

    let user = await repository.findOneBy({id});

    if (!user) {
      user = new User({ id, depth: 0, directReferralsCount: 0 });
      await repository.save(user);
    }
    return user;
  }

  // Start to filter events
  for (const block of ctx.blocks) {
    for (const item of block.items) {
      if (item.kind === "evmLog") {

        const { evmLog, transaction } = item;

        const eventID = `${evmLog.index.toString()}`;

        let event: Event = new Event({
          id: eventID,
          createdAt: new Date(block.header.timestamp),
          txHash: transaction.hash,
        });

        let user: User | null;

        if (item.address === CORE_PROXY_ADDRESS) {

          const marketingReferrerChanged = 
            core.events.MarketingReferrerChanged;
          const endPackSet = 
            core.events.TimestampEndPackSet;
          
          if (
            evmLog.topics[0] === marketingReferrerChanged.topic
          ) {
            const mgr: EntityManager = await ctx.store["em"]();
            const repository = mgr.getTreeRepository(User);

            const { accountId, marketingReferrer } = 
              marketingReferrerChanged.decode(evmLog);

              user = await repository.findOneBy({
                id: accountId.toString(),
              });

            // If marketing referrer changes to zero
            if (marketingReferrer.isZero()) {
              if (user) {
                const referrer = user.marketingReferrer;

                // Decrease referrals count
                if (referrer) {
                  referrer.directReferralsCount -= 1;
                  await repository.save(referrer);
                }

                /**
                 * @notice Пимечание из задачи:
                 * если marketingReferrer == 0x0, то пользователь удаляется из дерева.
                 */
                ctx.log.info(`Removing user: ${user.id} with no marketingReferrer`);
                await repository.remove(user);
              }
              continue;
            }

            if (!user) {
              user = new User({
                id: accountId.toString(),
                depth: 0,
                directReferralsCount: 0,
              });
            }

            // Update marketing referrer
            if (!accountId.eq(ROOT_ID)) {
              const referrer = await findOrCreateUser(
                marketingReferrer.toString()
              );
              user.marketingReferrer = referrer;
              user.depth = referrer.depth + 1;

              referrer.directReferralsCount += 1;
              await repository.save(referrer);
            }

            /**
             * @notice Примечание из задачи
             * Примечание для события MarketingReferrerChanged:
             * accountId – всегда новый пользователь в дереве.
             */
            ctx.log.info(`Change user in tree: ${user.id}`);
            await repository.save(user);

            event.eventLog = new MarketingReferrerChanged({
              accountId: accountId.toString(),
            });

            user = new User({ id: marketingReferrer.toString() });

          } else if (evmLog.topics[0] === endPackSet.topic) {
            const { accountId, level, timestamp } = endPackSet.decode(evmLog);

            user = await findOrCreateUser(accountId.toString());

            const packID = `${accountId.toString()}-${level.toString()}`;
            const packLevel = level.toNumber();

            // Timestamp in milliseconds
            const packExpiresAt = new Date(timestamp.toNumber() * 1000);

            const pack = new Pack({
              id: packID,
              user: user,
              level: packLevel,
              expiresAt: packExpiresAt,
            });

            await ctx.store.save(pack);

            event.eventLog = new TimestampEndPack({
              level: packLevel,
              timestamp: packExpiresAt,
            });
          }
        } else if (item.address === METAFORCE_PROXY_ADDRESS) {
          const revenueMFS = metaForce.events.RevenueMFS;
          const revenueStable = metaForce.events.RevenueStable;
          const lostMoney = metaForce.events.LostMoney;

          let userAccountId: BigNumber | null;

          if (evmLog.topics[0] === revenueMFS.topic) {
            const { fromId, accountId, amount } = revenueMFS.decode(evmLog);
            userAccountId = accountId;

            event.eventLog = new RevenueMFS({
              from: fromId.toString(),
              amount: amount.toBigInt(),
            });
          } else if (evmLog.topics[0] === revenueStable.topic) {
            const { fromId, accountId, amount } = revenueStable.decode(evmLog);
            userAccountId = accountId;

            event.eventLog = new RevenueStable({
              from: fromId.toString(),
              amount: amount.toBigInt(),
            });
          } else if (evmLog.topics[0] === lostMoney.topic) {
            const { fromId, accountId, amount } = lostMoney.decode(evmLog);
            userAccountId = accountId;

            event.eventLog = new LostMoney({
              from: fromId.toString(),
              amount: amount.toBigInt(),
            });
          }

          user = await findOrCreateUser(userAccountId!.toString());
        }

        event.user = user!;

        await ctx.store.save(event);
      }
    }
  }
});

