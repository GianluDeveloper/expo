import './install';

import type { ExpoRoutesManifestV1, RouteInfo } from 'expo-router/build/routes-manifest';
import fs from 'node:fs';
import path from 'node:path';

import { ExpoRouterServerManifestV1FunctionRoute } from './types';

const debug =
  process.env.NODE_ENV === 'development'
    ? (require('debug')('expo:server') as typeof console.log)
    : () => {};

function getProcessedManifest(path: string): ExpoRoutesManifestV1<RegExp> {
  // TODO: JSON Schema for validation
  const routesManifest = JSON.parse(fs.readFileSync(path, 'utf-8')) as ExpoRoutesManifestV1;

  const parsed: ExpoRoutesManifestV1<RegExp> = {
    ...routesManifest,
    notFoundRoutes: routesManifest.notFoundRoutes.map((value: any) => {
      return { ...value, namedRegex: new RegExp(value.namedRegex) };
    }),
    apiRoutes: routesManifest.apiRoutes.map((value: any) => {
      return { ...value, namedRegex: new RegExp(value.namedRegex) };
    }),
    htmlRoutes: routesManifest.htmlRoutes.map((value: any) => {
      return { ...value, namedRegex: new RegExp(value.namedRegex) };
    }),
    redirects: routesManifest.redirects?.map((value: any) => {
      return { ...value, namedRegex: new RegExp(value.namedRegex) };
    }),
    rewrites: routesManifest.rewrites?.map((value: any) => {
      return { ...value, namedRegex: new RegExp(value.namedRegex) };
    }),
  };

  return parsed;
}

export function getRoutesManifest(distFolder: string) {
  return getProcessedManifest(path.join(distFolder, '_expo/routes.json'));
}

// TODO: Reuse this for dev as well
export function createRequestHandler(
  distFolder: string,
  {
    getRoutesManifest: getInternalRoutesManifest,
    getHtml = async (_request, route) => {
      // Serve a static file by exact route name
      const filePath = path.join(distFolder, route.page + '.html');
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }

      // Serve a static file by route name with hoisted index
      // See: https://github.com/expo/expo/pull/27935
      const hoistedFilePath = route.page.match(/\/index$/)
        ? path.join(distFolder, route.page.replace(/\/index$/, '') + '.html')
        : null;
      if (hoistedFilePath && fs.existsSync(hoistedFilePath)) {
        return fs.readFileSync(hoistedFilePath, 'utf-8');
      }

      return null;
    },
    getApiRoute = async (route) => {
      const filePath = path.join(distFolder, route.file);

      debug(`Handling API route: ${route.page}: ${filePath}`);

      // TODO: What's the standard behavior for malformed projects?
      if (!fs.existsSync(filePath)) {
        return null;
      }

      if (/\.c?js$/.test(filePath)) {
        return require(filePath);
      }
      return import(filePath);
    },
    logApiRouteExecutionError = (error: Error) => {
      console.error(error);
    },
    handleApiRouteError = async (error: Error) => {
      if ('statusCode' in error && typeof error.statusCode === 'number') {
        return new Response(error.message, {
          status: error.statusCode,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      return new Response('Internal server error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  }: {
    getHtml?: (request: Request, route: RouteInfo<RegExp>) => Promise<string | Response | null>;
    getRoutesManifest?: (distFolder: string) => Promise<ExpoRoutesManifestV1<RegExp> | null>;
    getApiRoute?: (route: RouteInfo<RegExp>) => Promise<any>;
    logApiRouteExecutionError?: (error: Error) => void;
    handleApiRouteError?: (error: Error) => Promise<Response>;
  } = {}
) {
  let routesManifest: ExpoRoutesManifestV1<RegExp> | undefined;

  return async function handler(request: Request): Promise<Response> {
    if (getInternalRoutesManifest) {
      const manifest = await getInternalRoutesManifest(distFolder);
      if (manifest) {
        routesManifest = manifest;
      } else {
        // Development error when Expo Router is not setup.
        return new Response('No routes manifest found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    } else if (!routesManifest) {
      routesManifest = getRoutesManifest(distFolder);
    }

    const url = new URL(request.url, 'http://expo.dev');

    let sanitizedPathname = url.pathname;

    debug('Request', sanitizedPathname);

    if (routesManifest.redirects) {
      for (const route of routesManifest.redirects) {
        if (!route.namedRegex.test(sanitizedPathname)) {
          continue;
        }

        if (route.methods && !route.methods.includes(request.method)) {
          continue;
        }

        const Location = getRedirectRewriteLocation(request, route);

        if (Location) {
          debug('Redirecting', Location);

          // Get the params
          return new Response(null, { status: route.permanent ? 308 : 307, headers: { Location } });
        }
      }
    }

    if (routesManifest.rewrites) {
      for (const route of routesManifest.rewrites) {
        if (!route.namedRegex.test(sanitizedPathname)) {
          continue;
        }

        if (route.methods && !route.methods.includes(request.method)) {
          continue;
        }

        const url = getRedirectRewriteLocation(request, route);
        request = new Request(new URL(url, new URL(request.url).origin), request);
        sanitizedPathname = new URL(request.url, 'http://expo.dev').pathname;
      }
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      // First test static routes
      for (const route of routesManifest.htmlRoutes) {
        if (!route.namedRegex.test(sanitizedPathname)) {
          continue;
        }

        // // Mutate to add the expoUrl object.
        updateRequestWithConfig(request, route);

        // serve a static file
        const contents = await getHtml(request, route);

        // TODO: What's the standard behavior for malformed projects?
        if (!contents) {
          return new Response('Not found', {
            status: 404,
            headers: { 'Content-Type': 'text/plain' },
          });
        } else if (contents instanceof Response) {
          return contents;
        }

        return new Response(contents, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
    }

    // Next, test API routes
    for (const route of routesManifest.apiRoutes) {
      if (!route.namedRegex.test(sanitizedPathname)) {
        continue;
      }

      const func = await getApiRoute(route);

      if (func instanceof Response) {
        return func;
      }

      const routeHandler = func?.[request.method];
      if (!routeHandler) {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // Mutate to add the expoUrl object.
      const params = updateRequestWithConfig(request, route);

      try {
        // TODO: Handle undefined
        return (await routeHandler(request, params)) as Response;
      } catch (error) {
        if (error instanceof Error) {
          logApiRouteExecutionError(error);
        }

        return handleApiRouteError(error as Error);
      }
    }

    // Finally, test 404 routes
    for (const route of routesManifest.notFoundRoutes) {
      if (!route.namedRegex.test(sanitizedPathname)) {
        continue;
      }

      // // Mutate to add the expoUrl object.
      updateRequestWithConfig(request, route);

      // serve a static file
      const contents = await getHtml(request, route);

      // TODO: What's the standard behavior for malformed projects?
      if (!contents) {
        return new Response('Not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      } else if (contents instanceof Response) {
        return contents;
      }

      return new Response(contents, { status: 404, headers: { 'Content-Type': 'text/html' } });
    }

    // 404
    const response = new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
    return response;
  };
}

function updateRequestWithConfig(
  request: Request,
  config: ExpoRouterServerManifestV1FunctionRoute
) {
  const params: Record<string, string> = {};
  const url = new URL(request.url);
  const match = config.namedRegex.exec(url.pathname);
  if (match?.groups) {
    for (const [key, value] of Object.entries(match.groups)) {
      const namedKey = config.routeKeys[key];
      params[namedKey] = value;
    }
  }

  return params;
}

/** Match `[page]` -> `page` or `[...group]` -> `...group` */
const dynamicNameRe = /^\[([^[\]]+?)\]$/;

function getRedirectRewriteLocation(request: Request, route: RouteInfo<RegExp>) {
  const params = updateRequestWithConfig(request, route);

  const urlSearchParams = new URL(request.url).searchParams;

  let location = route.page
    .split('/')
    .map((segment) => {
      let paramName = segment.match(dynamicNameRe)?.[1];
      if (!paramName) {
        return segment;
      } else if (paramName.startsWith('...')) {
        paramName = paramName.slice(3);
        const value = params[paramName];
        delete params[paramName];
        return value;
      } else {
        const value = params[paramName];
        delete params[paramName];
        return value?.split('/')[0];
      }
    })
    .join('/');

  if (Object.keys(params).length > 0 || urlSearchParams.size > 0) {
    location +=
      '?' +
      new URLSearchParams({
        ...params,
        ...Object.fromEntries(urlSearchParams.entries()),
      }).toString();
  }

  return location;
}
