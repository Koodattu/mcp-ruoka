export const CACHE_MS = {
	labels: 30 * 86400_000,
	stores: 7 * 86400_000,
	membership: 86400_000,
	offers: 6 * 3600_000,
	availability: 60_000,
};

export function offerExpiry(
	products: Array<{
		source: { fetchedAt: string };
		pricing: {
			validUntil: string | null;
			promotions: Array<{ validFrom: string | null; validUntil: string | null }>;
		};
	}>,
	now = Date.now(),
) {
	return Math.min(
		now + CACHE_MS.offers,
		...products
			.flatMap((p) => [
				Date.parse(p.source.fetchedAt) + CACHE_MS.offers,
				...(p.pricing.validUntil ? [Date.parse(p.pricing.validUntil)] : []),
				...p.pricing.promotions.flatMap((promo) =>
					[promo.validFrom, promo.validUntil].flatMap((d) =>
						d && Date.parse(d) > Date.parse(p.source.fetchedAt) ? [Date.parse(d)] : [],
					),
				),
			])
			.filter(Number.isFinite),
	);
}
