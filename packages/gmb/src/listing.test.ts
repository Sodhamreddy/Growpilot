import { describe, expect, it } from "vitest";
import { belongsToGbpListing, listingSelection } from "./listing.js";

describe("listing selection", () => {
  it("drops stale reply targets, totals, and source state on a new Maps link", () => {
    expect(listingSelection({ mapsLink: "https://maps.app.goo.gl/old", gbpLocation: "accounts/1/locations/old",
      mapsUri: "https://maps.google.com/old", title: "Old", rating: 5, source: "gbp" },
    { mapsLink: "https://maps.app.goo.gl/new", mapsUri: "https://maps.app.goo.gl/new" })).toEqual({
      changed: true, listing: { mapsLink: "https://maps.app.goo.gl/new", mapsUri: "https://maps.app.goo.gl/new" },
    });
  });
  it("preserves metadata only for a matching proven identifier", () => {
    expect(listingSelection({ placeId: "same", rating: 4 }, { placeId: "same", title: "Updated" }))
      .toEqual({ changed: false, listing: { placeId: "same", rating: 4, title: "Updated" } });
    expect(listingSelection({ gbpLocation: "accounts/1/locations/a", placeId: "a" },
      { gbpLocation: "accounts/1/locations/b" }).listing).toEqual({ gbpLocation: "accounts/1/locations/b" });
  });
  it("allows only reviews from the selected Business Profile location", () => {
    const listing = { gbpLocation: "accounts/1/locations/2" };
    expect(belongsToGbpListing("accounts/1/locations/2/reviews/r", listing)).toBe(true);
    expect(belongsToGbpListing("accounts/1/locations/20/reviews/r", listing)).toBe(false);
    expect(belongsToGbpListing("accounts/1/locations/2/reviews/", listing)).toBe(false);
    expect(belongsToGbpListing("accounts/1/locations/2/reviews/r", null)).toBe(false);
  });
});
