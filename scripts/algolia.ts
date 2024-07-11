/* eslint-disable no-console */

/**
 * This script is used to index the static docs HTML files generated by Next.js into Algolia.
 *
 * It's a migration from the Gatsby solution,
 * which relied on the `gatsby-plugin-algolia`: https://github.com/getsentry/sentry-docs/blob/3c1361bdcb23a0fcee1f3019bca7c14a5d632162/src/gatsby/utils/algolia.ts
 *
 * The record generation logic is reused as is, with *two* notable changes:
 *   1. We manually feed the HTML files to the record generation function
 *   2. We manually upload the records to Algolia
 *
 * This script is meant to be run on a GitHub Action (see `.github/workflows/algolia-index.yml`).
 *
 * If you want to run it locally,
 *   1. Make sure you have the required env vars set up
 *   2. Be careful to change to `DOCS_INDEX_NAME` to a value different
 *      from the productoin docs index name (specified in the `@sentry-internal/global-search`)
 *      to avoid accidental deletions
 *   3. Run a production build of the app before running this script
 */

import fs from 'fs';
import {join} from 'path';

import {extrapolate, htmlToAlgoliaRecord} from '@sentry-internal/global-search';
import algoliasearch, {SearchIndex} from 'algoliasearch';

import {getDevDocsFrontMatter, getDocsFrontMatter} from '../src/mdx';
import {FrontMatter} from '../src/types';
import { isDeveloperDocs } from 'sentry-docs/isDeveloperDocs';

// This is the path to the static files generated by Next.js for the app directory
// The directory structure is not documented and could change in the future
// The ideal way to do this is probably to run production server and fetch the HTML from there.
const staticHtmlFilesPath = join(process.cwd(), '.next', 'server', 'app');

const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID;
const ALGOLIA_API_KEY = process.env.ALGOLIA_API_KEY;
const DOCS_INDEX_NAME = process.env.DOCS_INDEX_NAME;
// If set to true, the script will skip indexing a page if it encounters an error
const ALOGOLIA_SKIP_ON_ERROR = process.env.ALOGOLIA_SKIP_ON_ERROR === 'true';

if (!ALGOLIA_APP_ID) {
  throw new Error('`ALGOLIA_APP_ID` env var must be configured in repo secrets');
}
if (!ALGOLIA_API_KEY) {
  throw new Error('`ALGOLIA_API_KEY` env var must be configured in repo secrets');
}
if (!DOCS_INDEX_NAME) {
  throw new Error('`DOCS_INDEX_NAME` env var must be configured in repo secrets');
}

const client = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_API_KEY);
const index = client.initIndex(DOCS_INDEX_NAME);

indexAndUpload();
async function indexAndUpload() {
  // the page front matters are the source of truth for the static doc routes
  // as they are used directly by generateStaticParams() on [[..path]] page
  const pageFrontMatters = isDeveloperDocs ? getDevDocsFrontMatter() : await getDocsFrontMatter();
  const records = await generateAlogliaRecords(pageFrontMatters);
  console.log('🔥 Generated %d new Algolia records.', records.length);
  const existingRecordIds = await fetchExistingRecordIds(index);
  console.log(
    '🔥 Found %d existing Algolia records in `%s`',
    existingRecordIds.length,
    DOCS_INDEX_NAME
  );
  console.log('🔥 Saving new records to `%s`...', DOCS_INDEX_NAME);
  const saveResult = await index.saveObjects(records, {
    batchSize: 10000,
    autoGenerateObjectIDIfNotExist: true,
  });
  const newRecordIDs = new Set(saveResult.objectIDs);
  console.log('🔥 Saved %d records', newRecordIDs.size);

  const recordsToDelete = existingRecordIds.filter(id => !newRecordIDs.has(id));
  if (recordsToDelete.length === 0) {
    console.log('🔥 No stale records to delete');
    return;
  }
  console.log('🔥 Deleting old (stale) records ...');
  const deleteResult = await index.deleteObjects(recordsToDelete);
  console.log(
    '🔥 Deleted %d stale records from `%s`',
    deleteResult.objectIDs.length,
    DOCS_INDEX_NAME
  );
}

async function fetchExistingRecordIds(algoliaIndex: SearchIndex) {
  console.log('🔥 fetching existing records ids ...');
  const existingRecordIds = new Set<string>();
  await algoliaIndex.browseObjects({
    attributesToRetrieve: ['objectID'],
    batch: chunk => {
      chunk.forEach(record => {
        existingRecordIds.add(record.objectID);
      });
    },
  });
  return Array.from(existingRecordIds);
}

async function generateAlogliaRecords(pageFrontMatters: FrontMatter[]) {
  const records = await Promise.all(
    pageFrontMatters
      .filter(
        frontMatter => !frontMatter.draft && !frontMatter.noindex && frontMatter.title
      )
      .map(getRecords)
  );

  return records.flat();
}

async function getRecords(pageFm: FrontMatter) {
  console.log('processing:', pageFm.slug);

  try {
    const htmlFile = join(staticHtmlFilesPath, pageFm.slug + '.html');
    const html = fs.readFileSync(htmlFile).toString();
    const pageRecords = await htmlToAlgoliaRecord(
      html,
      {
        title: pageFm.title,
        url: '/' + pageFm.slug + '/',
        pathSegments: extrapolate(pageFm.slug, '/').map(x => `/${x}/`),
        keywords: pageFm.keywords,
      },
      '#main'
    );

    return pageRecords;
  } catch (e) {
    const error = new Error(`🔴 Error processing ${pageFm.slug}: ${e.message}`, {
      cause: e,
    });
    if (ALOGOLIA_SKIP_ON_ERROR) {
      console.error(error);
      return [];
    }
    throw error;
  }
}
