---
name: swiggy
description: Search for food delivery options on Swiggy near the user's location
metadata:
  category: food
  requires_location: true
---

# Swiggy Food Search

You can search for restaurants and food items on Swiggy using the user's location.

## When to use

- The user asks for food, restaurants, or delivery options nearby.
- The user wants to order food from a specific cuisine or restaurant.

## Parameters

- `query` (string, required): The food item or restaurant name to search for.
- `lat` (number, required): Latitude of the user's location. Default: 12.9716 (Bengaluru).
- `lng` (number, required): Longitude of the user's location. Default: 77.5946 (Bengaluru).

## Behavior

1. Search Swiggy for the given query near the provided coordinates.
2. Return the top results including restaurant name, rating, estimated delivery time, and price range.
3. Always present at least 2 options so the user can choose.
