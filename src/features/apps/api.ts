"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MyApp, MyAppInput } from "@/features/apps/apps";
import type { AppsApi, AppsErrorCode, AppsResult } from "@/features/apps/bridge";

export class AppsApiError extends Error {
  constructor(readonly code: AppsErrorCode | "unavailable") {
    super(code);
  }
}

/** The MyApps bridge; absent when the UI is opened in a regular browser instead of the app. */
export function appsBridge(): AppsApi {
  if (!window.appsApi) throw new AppsApiError("unavailable");
  return window.appsApi;
}

export async function unwrapApps<T>(pending: Promise<AppsResult<T>>): Promise<T> {
  const result = await pending;
  if (result.ok) return result.data;
  throw new AppsApiError(result.error);
}

const appsKey = ["myApps"];

export function useApps() {
  return useQuery({
    queryKey: appsKey,
    queryFn: () => unwrapApps(appsBridge().listApps()),
    staleTime: Infinity,
  });
}

export function useSaveApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MyAppInput) => unwrapApps(appsBridge().saveApp(input)),
    onSuccess: (saved) =>
      queryClient.setQueryData<MyApp[]>(appsKey, (apps = []) =>
        apps.some((item) => item.id === saved.id)
          ? apps.map((item) => (item.id === saved.id ? saved : item))
          : [...apps, saved],
      ),
  });
}

export function useRemoveApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrapApps(appsBridge().removeApp({ id })),
    onSuccess: (_result, id) =>
      queryClient.setQueryData<MyApp[]>(appsKey, (apps = []) => apps.filter((item) => item.id !== id)),
  });
}

/** Reorders at once, and puts the saved order back if saving fails. */
export function useReorderApps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => unwrapApps(appsBridge().setAppOrder({ ids })),
    onMutate: (ids) => {
      const previous = queryClient.getQueryData<MyApp[]>(appsKey);
      if (previous) {
        const byId = new Map(previous.map((item) => [item.id, item]));
        queryClient.setQueryData(appsKey, ids.flatMap((id) => byId.get(id) ?? []));
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(appsKey, context.previous);
    },
    onSuccess: (apps) => queryClient.setQueryData(appsKey, apps),
  });
}

export function useClearTrustedCerts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrapApps(appsBridge().clearTrustedCerts({ id })),
    onSuccess: (saved) =>
      queryClient.setQueryData<MyApp[]>(appsKey, (apps = []) =>
        apps.map((item) => (item.id === saved.id ? saved : item)),
      ),
  });
}

/** Opens an app in its own window or the default browser (embedded apps are linked to instead). */
export function useOpenApp() {
  return useMutation({
    mutationFn: (input: { id: string; mode?: "window" | "browser" }) =>
      unwrapApps(appsBridge().openApp(input)),
  });
}

/** Asks for a program to run; resolves to it (path, suggested name, icon), or null when cancelled. */
export function useChooseProgram() {
  return useMutation({
    mutationFn: async () => (await unwrapApps(appsBridge().chooseProgram())).program,
  });
}

/** Asks for an image file; resolves to the icon to show and save, or null when cancelled. */
export function useChooseAppIcon() {
  return useMutation({
    mutationFn: async () => (await unwrapApps(appsBridge().chooseAppIcon())).icon,
  });
}
