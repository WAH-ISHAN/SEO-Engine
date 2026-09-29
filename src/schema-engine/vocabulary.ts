/**
 * A working subset of the Schema.org vocabulary.
 *
 * Only the types and properties this platform actually validates are listed. The point
 * is not to mirror Schema.org - it is to know, for the types sites really deploy, which
 * properties are required for the type to mean anything and which are commonly expected.
 */

export interface TypeSpec {
  /** Without these, the block does not describe its subject at all. */
  required: string[];
  /** Widely expected; absence is worth reporting but is not a defect. */
  recommended: string[];
  /** Properties whose value must correspond to something visible on the page. */
  mustMatchContent?: string[];
  parents?: string[];
}

export const TYPE_SPECS: Record<string, TypeSpec> = {
  Organization: {
    required: ['name'],
    recommended: ['url', 'logo', 'description', 'sameAs', 'contactPoint'],
    mustMatchContent: ['name'],
  },
  LocalBusiness: {
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHours', 'geo', 'url', 'priceRange', 'image'],
    mustMatchContent: ['name', 'telephone'],
    parents: ['Organization'],
  },
  Person: {
    required: ['name'],
    recommended: ['url', 'jobTitle', 'description', 'sameAs', 'image'],
    mustMatchContent: ['name'],
  },
  WebSite: {
    required: ['name', 'url'],
    recommended: ['publisher', 'potentialAction', 'inLanguage'],
  },
  WebPage: {
    required: ['name'],
    recommended: ['url', 'description', 'isPartOf', 'breadcrumb', 'datePublished'],
  },
  Article: {
    required: ['headline', 'author'],
    recommended: ['datePublished', 'dateModified', 'image', 'publisher', 'description', 'mainEntityOfPage'],
    mustMatchContent: ['headline'],
  },
  BlogPosting: {
    required: ['headline', 'author'],
    recommended: ['datePublished', 'dateModified', 'image', 'publisher', 'description'],
    mustMatchContent: ['headline'],
    parents: ['Article'],
  },
  NewsArticle: {
    required: ['headline', 'author', 'datePublished'],
    recommended: ['dateModified', 'image', 'publisher', 'description'],
    mustMatchContent: ['headline'],
    parents: ['Article'],
  },
  Product: {
    required: ['name'],
    recommended: ['image', 'description', 'brand', 'offers', 'sku', 'aggregateRating', 'review'],
    mustMatchContent: ['name'],
  },
  Offer: {
    required: ['price', 'priceCurrency'],
    recommended: ['availability', 'url', 'priceValidUntil'],
    mustMatchContent: ['price'],
  },
  Service: {
    required: ['name'],
    recommended: ['provider', 'description', 'areaServed', 'serviceType', 'offers'],
    mustMatchContent: ['name'],
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
    mustMatchContent: ['mainEntity'],
  },
  QAPage: {
    required: ['mainEntity'],
    recommended: [],
    mustMatchContent: ['mainEntity'],
  },
  Question: {
    required: ['name', 'acceptedAnswer'],
    recommended: ['answerCount', 'upvoteCount'],
    mustMatchContent: ['name'],
  },
  HowTo: {
    required: ['name', 'step'],
    recommended: ['totalTime', 'supply', 'tool', 'image', 'description'],
    mustMatchContent: ['name', 'step'],
  },
  Recipe: {
    required: ['name', 'recipeIngredient', 'recipeInstructions'],
    recommended: ['image', 'author', 'prepTime', 'cookTime', 'nutrition', 'recipeYield'],
    mustMatchContent: ['name'],
  },
  Event: {
    required: ['name', 'startDate', 'location'],
    recommended: ['endDate', 'description', 'offers', 'performer', 'eventStatus'],
    mustMatchContent: ['name', 'startDate'],
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
    mustMatchContent: ['itemListElement'],
  },
  ItemList: {
    required: ['itemListElement'],
    recommended: ['numberOfItems', 'name'],
  },
  VideoObject: {
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['description', 'duration', 'contentUrl', 'embedUrl'],
    mustMatchContent: ['name'],
  },
  ImageObject: {
    required: ['contentUrl'],
    recommended: ['caption', 'width', 'height', 'license'],
  },
  Review: {
    required: ['reviewRating', 'author'],
    recommended: ['itemReviewed', 'datePublished', 'reviewBody'],
    mustMatchContent: ['reviewBody'],
  },
  AggregateRating: {
    required: ['ratingValue', 'ratingCount'],
    recommended: ['bestRating', 'worstRating', 'itemReviewed'],
    mustMatchContent: ['ratingValue'],
  },
  SoftwareApplication: {
    required: ['name'],
    recommended: ['applicationCategory', 'operatingSystem', 'offers', 'aggregateRating', 'description'],
    mustMatchContent: ['name'],
  },
  JobPosting: {
    required: ['title', 'description', 'hiringOrganization', 'datePosted'],
    recommended: ['jobLocation', 'baseSalary', 'employmentType', 'validThrough'],
    mustMatchContent: ['title'],
  },
  Course: {
    required: ['name', 'description', 'provider'],
    recommended: ['hasCourseInstance', 'offers'],
    mustMatchContent: ['name'],
  },
};

/**
 * Types that should appear once per page. A second BreadcrumbList or a second
 * Organization on the same page produces two conflicting statements about one thing.
 */
export const SINGLETON_TYPES = new Set([
  'WebSite', 'BreadcrumbList', 'FAQPage', 'QAPage', 'Organization', 'LocalBusiness',
]);

/** Properties whose value must be a valid ISO 8601 date or date-time. */
export const DATE_PROPERTIES = new Set([
  'datePublished', 'dateModified', 'dateCreated', 'startDate', 'endDate',
  'uploadDate', 'datePosted', 'validThrough', 'priceValidUntil', 'validFrom',
]);

/** Properties whose value must be an absolute URL. */
export const URL_PROPERTIES = new Set([
  'url', 'contentUrl', 'embedUrl', 'thumbnailUrl', 'logo', 'image', 'sameAs', 'mainEntityOfPage',
]);

export function specFor(type: string): TypeSpec | undefined {
  return TYPE_SPECS[type];
}

/**
 * Types a page of a given detected format would plausibly declare. Used to report
 * absent structured data - never to auto-add markup for content that does not match.
 */
export const FORMAT_TO_TYPE: Record<string, string> = {
  faq: 'FAQPage',
  'how-to': 'HowTo',
  article: 'Article',
  guide: 'Article',
  product: 'Product',
  listicle: 'ItemList',
};
