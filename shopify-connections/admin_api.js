// Thin wrapper around Shopify Admin GraphQL Admin API.
//
// All requests go to https://{shop}/admin/api/{version}/graphql.json
// authenticated with the X-Shopify-Access-Token header. The token is
// the permanent admin API access token returned by OAuth.

const axios = require('axios');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

async function graphql({ shop, accessToken, query, variables }) {
  if (!shop || !accessToken) throw new Error('shopify admin_api: shop and accessToken are required');
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const res = await axios.post(url, { query, variables }, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
  });
  // Shopify returns HTTP 200 + an errors array for invalid queries /
  // throttling. Surface those as exceptions so the caller can branch.
  if (res.data?.errors?.length) {
    const msg = res.data.errors.map((e) => e.message).join('; ');
    throw Object.assign(new Error(`Shopify GraphQL error: ${msg}`), {
      shopify: res.data.errors,
      status: 502,
    });
  }
  if (res.data?.data) return res.data.data;
  return res.data;
}

// Lightweight identity probe used after OAuth and by the health probe.
async function getShop({ shop, accessToken }) {
  const data = await graphql({
    shop, accessToken,
    query: `query { shop { id name myshopifyDomain primaryDomain { host } email } }`,
  });
  return data?.shop || null;
}

// List blogs so the user can pick a target (most stores have one
// default "News" blog, some have several).
async function listBlogs({ shop, accessToken }) {
  const data = await graphql({
    shop, accessToken,
    query: `query { blogs(first: 50) { edges { node { id title handle } } } }`,
  });
  return (data?.blogs?.edges || []).map((e) => e.node);
}

// Upload an image to Shopify Files via stagedUploadsCreate +
// fileCreate. Returns the GraphQL file id + the CDN URL we can drop
// into article body HTML.
async function uploadImageToShopifyFiles({ shop, accessToken, sourceUrl, filename }) {
  // 1. Get the upstream image bytes + content type.
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 30_000 });
  const buffer = Buffer.from(resp.data);
  const mime = (resp.headers['content-type'] || '').split(';')[0] || 'image/png';

  // 2. Ask Shopify for a staged upload target.
  const stagedData = await graphql({
    shop, accessToken,
    query: `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    variables: {
      input: [{
        resource: 'IMAGE',
        filename: filename || `image-${Date.now()}.png`,
        mimeType: mime,
        httpMethod: 'POST',
        fileSize: String(buffer.length),
      }],
    },
  });
  const target = stagedData?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error('stagedUploadsCreate returned no target');

  // 3. POST the bytes to Shopify's staged URL with the params they
  //    returned (multipart/form-data).
  const FormData = require('form-data');
  const form = new FormData();
  (target.parameters || []).forEach((p) => form.append(p.name, p.value));
  form.append('file', buffer, { filename: filename || 'image.png', contentType: mime });
  await axios.post(target.url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    timeout: 60_000,
  });

  // 4. Tell Shopify "here's the staged resource, register it as a File".
  const createData = await graphql({
    shop, accessToken,
    query: `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          ... on MediaImage { image { url width height } }
        }
        userErrors { field message }
      }
    }`,
    variables: {
      files: [{
        alt: filename || 'image',
        contentType: 'IMAGE',
        originalSource: target.resourceUrl,
      }],
    },
  });
  const file = createData?.fileCreate?.files?.[0];
  if (!file) throw new Error('fileCreate returned no file');
  // Shopify processes images asynchronously; the URL may be null on
  // first read. Poll briefly.
  let url = file?.image?.url || null;
  if (!url && file.id) {
    for (let i = 0; i < 6 && !url; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
      // eslint-disable-next-line no-await-in-loop
      const polled = await graphql({
        shop, accessToken,
        query: `query($id: ID!) { node(id: $id) { ... on MediaImage { image { url } } } }`,
        variables: { id: file.id },
      });
      url = polled?.node?.image?.url || null;
    }
  }
  return { id: file.id, url };
}

// Create a blog article. Shopify's GraphQL articleCreate accepts the
// body as HTML, plus a featured image (which we upload first).
async function createArticle({
  shop, accessToken,
  blogId,
  title,
  bodyHtml,
  authorName,
  handle,
  summary,
  tags,
  publishedAt,    // ISO string OR null for draft
  imageUrl,       // featured image; pass our generated fal.ai URL or a user-uploaded URL
  metaTitle,
  metaDescription,
}) {
  const variables = {
    article: {
      blogId,
      title,
      body: bodyHtml,
      summary: summary || null,
      handle: handle || null,
      author: authorName ? { name: authorName } : undefined,
      tags: Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined),
      isPublished: !!publishedAt,
      publishDate: publishedAt || undefined,
      image: imageUrl ? { url: imageUrl } : undefined,
    },
  };
  const data = await graphql({
    shop, accessToken,
    query: `mutation articleCreate($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article {
          id
          handle
          title
          isPublished
          publishedAt
          blog { id handle title }
        }
        userErrors { field message code }
      }
    }`,
    variables,
  });
  const userErrors = data?.articleCreate?.userErrors || [];
  if (userErrors.length) {
    const msg = userErrors.map((e) => `${e.field?.join('.') || ''}: ${e.message}`).join('; ');
    throw Object.assign(new Error(`Shopify articleCreate failed: ${msg}`), {
      shopify: userErrors,
      status: 422,
    });
  }
  const article = data?.articleCreate?.article;
  if (!article) throw new Error('articleCreate returned no article');

  // Set SEO metafields (title + description) after creation, since
  // ArticleCreateInput doesn't accept them directly in 2024-10.
  if (metaTitle || metaDescription) {
    try {
      await graphql({
        shop, accessToken,
        query: `mutation metaSet($ownerId: ID!, $metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
        variables: {
          ownerId: article.id,
          metafields: [
            metaTitle ? { ownerId: article.id, namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: metaTitle } : null,
            metaDescription ? { ownerId: article.id, namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: metaDescription } : null,
          ].filter(Boolean),
        },
      });
    } catch (err) {
      // SEO metafields are best-effort; the article publishes regardless.
      console.warn('[shopify admin_api] metafieldsSet failed:', err.message || err);
    }
  }

  // Compose the public URL the user will click to view the article.
  let url = null;
  if (article.blog?.handle && article.handle) {
    try {
      // Use the shop's primary domain if we have it cached, otherwise
      // myshopify.com. The caller can rewrite if they have shop_domain.
      url = `https://${shop}/blogs/${article.blog.handle}/${article.handle}`;
    } catch { /* ignore */ }
  }
  return { ...article, url };
}

module.exports = {
  API_VERSION,
  graphql,
  getShop,
  listBlogs,
  uploadImageToShopifyFiles,
  createArticle,
};
