import { invoke, SeelenCommand, SeelenEvent, subscribe } from "@seelen-ui/lib";
import type { SeelenFont } from "@seelen-ui/lib/types";
import { computed, signal } from "@preact/signals";
import { Select } from "antd";
import { useEffect } from "react";

interface Props {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
}

const fonts = signal<SeelenFont[]>([]);
const loading = signal(false);
let loaded = false;
let revision = 0;
let request: Promise<void> | null = null;
let subscribed: Promise<unknown> | null = null;
const options = computed(() =>
  fonts.value.map((f) => ({
    value: f.family,
    label: <span style={{ fontFamily: f.family }}>{f.family}</span>,
  }))
);

function loadFonts(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (request) return request;
  loading.value = true;
  subscribed ??= subscribe(SeelenEvent.SystemFontsChanged, ({ payload }) => {
    revision++;
    fonts.value = payload;
  }).catch((error) => {
    subscribed = null;
    throw error;
  });
  request = subscribed.then(async () => {
    const currentRevision = revision;
    const snapshot = await invoke(SeelenCommand.GetFonts);
    if (revision === currentRevision) fonts.value = snapshot;
    loaded = true;
  }).catch(console.error).finally(() => {
    loading.value = false;
    request = null;
  });
  return request;
}

export function FontSelect({ value, defaultValue, onChange, style }: Props) {
  useEffect(() => {
    loadFonts();
  }, []);
  return (
    <Select
      showSearch={{ optionFilterProp: "value" }}
      allowClear
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      options={options.value}
      loading={loading.value}
      onOpenChange={(open) => {
        if (open) loadFonts();
      }}
      style={{ minWidth: 200, ...style }}
    />
  );
}
