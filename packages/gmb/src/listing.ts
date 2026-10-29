import type { GoogleListing } from "@ob/db";

/** An unproven fallback URL must never carry another listing's reply target. */
export function listingSelection(previous: GoogleListing | null, selected: GoogleListing): { listing: GoogleListing; changed: boolean } {
  const key = selected.gbpLocation ? "gbpLocation" : selected.placeId ? "placeId" : "mapsLink";
  const same = Boolean(previous?.[key] && previous[key] === selected[key]);
  return { listing: same ? { ...previous, ...selected } : selected, changed: !same };
}

export function belongsToGbpListing(externalId: string, listing: GoogleListing | null): boolean {
  return Boolean(listing?.gbpLocation && externalId.startsWith(`${listing.gbpLocation}/reviews/`)
    && externalId.slice(`${listing.gbpLocation}/reviews/`.length).length > 0);
}
