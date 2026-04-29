/**
 * Schemas canónicos para Google Places (autocomplete + details).
 * Cliente iOS: PlacePrediction y PlaceDetails en Route.swift.
 */

const { z } = require("zod");

const PlacePredictionSchema = z.object({
  placeId:       z.string().min(1),
  mainText:      z.string(),
  secondaryText: z.string(),
  fullText:      z.string(),
});

const AutocompleteResultSchema = z.object({
  predictions: z.array(PlacePredictionSchema),
});

const PlaceDetailsSchema = z.object({
  placeId: z.string().min(1),
  name:    z.string(),
  address: z.string(),
  lat:     z.number(),
  lng:     z.number(),
});

module.exports = { PlacePredictionSchema, AutocompleteResultSchema, PlaceDetailsSchema };
