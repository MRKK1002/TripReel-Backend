function activeReservationExpression(claimKey, reservationField, releaseField) {
  return {
    $and: [
      {
        $in: [claimKey, { $ifNull: [`$${reservationField}`, []] }],
      },
      {
        $not: [
          {
            $in: [claimKey, { $ifNull: [`$${releaseField}`, []] }],
          },
        ],
      },
    ],
  };
}

function buildReservationClaimFilter({
  id,
  claimKey,
  seats,
  reservationField = "inventoryReservationClaimKeys",
  releaseField = "inventoryReleaseClaimKeys",
  capacityField = "totalSeats",
}) {
  return {
    _id: id,
    $or: [
      {
        [reservationField]: claimKey,
        [releaseField]: { $ne: claimKey },
      },
      {
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ["$bookedSeats", 0] }, seats] },
            `$${capacityField}`,
          ],
        },
      },
    ],
  };
}

function buildReservationClaimPipeline({
  claimKey,
  seats,
  reservationField = "inventoryReservationClaimKeys",
  releaseField = "inventoryReleaseClaimKeys",
}) {
  return [
    {
      $set: {
        bookedSeats: {
          $cond: [
            activeReservationExpression(
              claimKey,
              reservationField,
              releaseField,
            ),
            { $ifNull: ["$bookedSeats", 0] },
            { $add: [{ $ifNull: ["$bookedSeats", 0] }, seats] },
          ],
        },
        [reservationField]: {
          $setUnion: [
            { $ifNull: [`$${reservationField}`, []] },
            [claimKey],
          ],
        },
        [releaseField]: {
          $setDifference: [
            { $ifNull: [`$${releaseField}`, []] },
            [claimKey],
          ],
        },
      },
    },
  ];
}

function buildReservationReleaseFilter({
  id,
  claimKey,
  reservationField = "inventoryReservationClaimKeys",
  releaseField = "inventoryReleaseClaimKeys",
}) {
  return {
    _id: id,
    [reservationField]: claimKey,
    [releaseField]: { $ne: claimKey },
  };
}

function buildReservationReleasePipeline({
  claimKey,
  seats,
  releaseField = "inventoryReleaseClaimKeys",
}) {
  return [
    {
      $set: {
        bookedSeats: {
          $max: [
            0,
            { $subtract: [{ $ifNull: ["$bookedSeats", 0] }, seats] },
          ],
        },
        [releaseField]: {
          $setUnion: [
            { $ifNull: [`$${releaseField}`, []] },
            [claimKey],
          ],
        },
      },
    },
  ];
}

module.exports = {
  buildReservationClaimFilter,
  buildReservationClaimPipeline,
  buildReservationReleaseFilter,
  buildReservationReleasePipeline,
};
