require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const Reel = require("../models/Reel");
const {
  generateReelThumbnail,
  removeOwnedReelMedia,
  resolveOwnedReelMediaPath,
} = require("../utils/reelMedia");

const APPLY = process.argv.includes("--apply");
const reelIdArg = process.argv.find((arg) => arg.startsWith("--reel-id="));
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const reelId = reelIdArg?.slice("--reel-id=".length).trim();
const limit = Math.max(0, Number(limitArg?.slice("--limit=".length)) || 0);
const blankThumbnail = {
  $or: [
    { thumbnail: "" },
    { thumbnail: null },
    { thumbnail: { $exists: false } },
  ],
};

const main = async () => {
  const mongoUri = process.env.mongodburl;
  if (!mongoUri) throw new Error("mongodburl not found in the environment.");
  if (reelId && !mongoose.isValidObjectId(reelId)) {
    throw new Error("--reel-id must be a valid MongoDB ObjectId.");
  }

  await mongoose.connect(mongoUri, { autoIndex: false });
  const query = reelId ? { $and: [{ _id: reelId }, blankThumbnail] } : blankThumbnail;
  let databaseQuery = Reel.find(query).sort({ createdAt: 1 });
  if (limit) databaseQuery = databaseQuery.limit(limit);
  const reels = await databaseQuery.lean();
  const counts = { eligible: reels.length, generated: 0, skipped: 0, failed: 0 };

  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"}: ${reels.length} reel(s) with no thumbnail.`,
  );

  for (const reel of reels) {
    const inputPath = resolveOwnedReelMediaPath(reel.video);
    if (!inputPath || !fs.existsSync(inputPath)) {
      counts.skipped += 1;
      console.warn(`SKIP ${reel._id}: owned source video is not available locally.`);
      continue;
    }

    if (!APPLY) {
      console.log(`READY ${reel._id}: ${inputPath}`);
      continue;
    }

    let generated;
    try {
      generated = await generateReelThumbnail(inputPath);
      const result = await Reel.updateOne(
        { _id: reel._id, ...blankThumbnail },
        { $set: { thumbnail: generated.publicPath } },
      );
      if (result.modifiedCount !== 1) {
        await removeOwnedReelMedia(generated.publicPath);
        counts.skipped += 1;
        console.warn(`SKIP ${reel._id}: thumbnail changed while backfill was running.`);
        continue;
      }
      counts.generated += 1;
      console.log(`OK ${reel._id}: ${generated.publicPath}`);
    } catch (error) {
      if (generated?.publicPath) {
        await removeOwnedReelMedia(generated.publicPath);
      }
      counts.failed += 1;
      console.error(`FAIL ${reel._id}: ${error.message}`);
    }
  }

  console.log(JSON.stringify(counts));
  if (counts.failed > 0) process.exitCode = 1;
};

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
