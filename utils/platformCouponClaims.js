function normalizedStringArrayExpression(path) {
  return {
    $map: {
      input: { $ifNull: [path, []] },
      as: "value",
      in: { $toLower: { $toString: "$$value" } },
    },
  };
}

function intersectsExpression(path, values) {
  return {
    $gt: [
      {
        $size: {
          $setIntersection: [
            normalizedStringArrayExpression(path),
            values.map((value) => String(value).toLowerCase()),
          ],
        },
      },
      0,
    ],
  };
}

function idContainsExpression(path, value) {
  return {
    $in: [
      String(value),
      {
        $map: {
          input: { $ifNull: [path, []] },
          as: "value",
          in: { $toString: "$$value" },
        },
      },
    ],
  };
}

function activeUserClaimCountExpression(userKey) {
  return {
    $size: {
      $reduce: {
        input: {
          $filter: {
            input: { $ifNull: ["$userUsageClaims", []] },
            as: "claim",
            cond: { $eq: ["$$claim.userKey", userKey] },
          },
        },
        initialValue: [],
        in: {
          $setUnion: ["$$value", { $ifNull: ["$$this.activeClaimKeys", []] }],
        },
      },
    },
  };
}

function targetingExpression({ pkg, packageId, operatorId }) {
  const categories = [pkg?.category, ...(pkg?.categories || [])].filter(
    Boolean,
  );
  const states = [pkg?.state].filter(Boolean);
  const cities = [pkg?.city].filter(Boolean);
  return {
    $or: [
      { $eq: ["$appliesTo", "all"] },
      {
        $and: [
          { $eq: ["$appliesTo", "category"] },
          intersectsExpression("$categories", categories),
        ],
      },
      {
        $and: [
          { $eq: ["$appliesTo", "destination"] },
          {
            $or: [
              intersectsExpression("$states", states),
              intersectsExpression("$cities", cities),
            ],
          },
        ],
      },
      {
        $and: [
          { $eq: ["$appliesTo", "package"] },
          idContainsExpression("$packageIds", packageId),
        ],
      },
      {
        $and: [
          { $eq: ["$appliesTo", "operator"] },
          idContainsExpression("$operatorIds", operatorId),
        ],
      },
    ],
  };
}

function buildPlatformCouponClaim({
  couponId,
  effectKey,
  userId,
  packageId,
  operatorId,
  pkg,
  seats,
  fareSubtotal,
  now = new Date(),
  hasPriorPublishedBooking = false,
}) {
  const userKey = String(userId);
  const isReplay = {
    $in: [effectKey, { $ifNull: ["$usageClaimKeys", []] }],
  };
  const activeUserCount = activeUserClaimCountExpression(userKey);
  const newUserClaim = {
    userKey,
    activeClaimKeys: [effectKey],
    lifetimeClaimKeys: [effectKey],
  };
  const appendUserClaim = {
    $let: {
      vars: { claims: { $ifNull: ["$userUsageClaims", []] } },
      in: {
        $cond: [
          {
            $in: [
              userKey,
              {
                $map: {
                  input: "$$claims",
                  as: "claim",
                  in: "$$claim.userKey",
                },
              },
            ],
          },
          {
            $map: {
              input: "$$claims",
              as: "claim",
              in: {
                $cond: [
                  { $eq: ["$$claim.userKey", userKey] },
                  {
                    $mergeObjects: [
                      "$$claim",
                      {
                        activeClaimKeys: {
                          $setUnion: [
                            { $ifNull: ["$$claim.activeClaimKeys", []] },
                            [effectKey],
                          ],
                        },
                        lifetimeClaimKeys: {
                          $setUnion: [
                            { $ifNull: ["$$claim.lifetimeClaimKeys", []] },
                            [effectKey],
                          ],
                        },
                      },
                    ],
                  },
                  "$$claim",
                ],
              },
            },
          },
          { $concatArrays: ["$$claims", [newUserClaim]] },
        ],
      },
    },
  };

  return {
    filter: {
      _id: couponId,
      $or: [
        { usageClaimKeys: effectKey },
        {
          $and: [
            { isActive: true },
            { isArchived: { $ne: true } },
            { validFrom: { $lte: now } },
            { validUntil: { $gte: now } },
            ...(hasPriorPublishedBooking
              ? [{ firstBookingOnly: { $ne: true } }]
              : []),
            {
              $expr: {
                $and: [
                  targetingExpression({ pkg, packageId, operatorId }),
                  { $lte: [{ $ifNull: ["$minGuests", 0] }, seats] },
                  {
                    $lte: [{ $ifNull: ["$minOrderAmount", 0] }, fareSubtotal],
                  },
                  {
                    $or: [
                      { $eq: [{ $ifNull: ["$usageLimit", 0] }, 0] },
                      {
                        $lt: [
                          { $ifNull: ["$usedCount", 0] },
                          { $ifNull: ["$usageLimit", 0] },
                        ],
                      },
                    ],
                  },
                  {
                    $lt: [
                      activeUserCount,
                      {
                        $cond: [
                          "$firstBookingOnly",
                          1,
                          { $ifNull: ["$perUserLimit", 1] },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    pipeline: [
      {
        $set: {
          usedCount: {
            $cond: [
              isReplay,
              { $ifNull: ["$usedCount", 0] },
              { $add: [{ $ifNull: ["$usedCount", 0] }, 1] },
            ],
          },
          everUsedCount: {
            $cond: [
              isReplay,
              { $ifNull: ["$everUsedCount", 0] },
              { $add: [{ $ifNull: ["$everUsedCount", 0] }, 1] },
            ],
          },
          firstUsedAt: {
            $cond: [
              isReplay,
              "$firstUsedAt",
              { $ifNull: ["$firstUsedAt", now] },
            ],
          },
          lastUsedAt: { $cond: [isReplay, "$lastUsedAt", now] },
          usageClaimKeys: {
            $setUnion: [{ $ifNull: ["$usageClaimKeys", []] }, [effectKey]],
          },
          userUsageClaims: {
            $cond: [isReplay, "$userUsageClaims", appendUserClaim],
          },
        },
      },
    ],
  };
}

function buildPlatformCouponRelease({ couponId, code, effectKey, userId }) {
  const userKey = String(userId);
  return {
    filter: {
      ...(couponId ? { _id: couponId } : { code }),
      usageClaimKeys: effectKey,
      releaseClaimKeys: { $ne: effectKey },
    },
    pipeline: [
      {
        $set: {
          usedCount: {
            $max: [0, { $subtract: [{ $ifNull: ["$usedCount", 0] }, 1] }],
          },
          releaseClaimKeys: {
            $setUnion: [{ $ifNull: ["$releaseClaimKeys", []] }, [effectKey]],
          },
          userUsageClaims: {
            $map: {
              input: { $ifNull: ["$userUsageClaims", []] },
              as: "claim",
              in: {
                $cond: [
                  { $eq: ["$$claim.userKey", userKey] },
                  {
                    $mergeObjects: [
                      "$$claim",
                      {
                        activeClaimKeys: {
                          $setDifference: [
                            { $ifNull: ["$$claim.activeClaimKeys", []] },
                            [effectKey],
                          ],
                        },
                      },
                    ],
                  },
                  "$$claim",
                ],
              },
            },
          },
        },
      },
    ],
  };
}

module.exports = {
  buildPlatformCouponClaim,
  buildPlatformCouponRelease,
};
