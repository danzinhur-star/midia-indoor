import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet, View, Text, Image, ImageBackground, TextInput,
  TouchableOpacity, BackHandler, Animated, Dimensions, StatusBar
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Video, ResizeMode } from 'expo-av';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as NavigationBar from 'expo-navigation-bar';
import { XMLParser } from 'fast-xml-parser';

const SUPABASE_MANIFEST_BASE = 'https://supabase.co';

const DEFAULT_BACKGROUNDS: Record<string, string> = {
  soccer_table: 'https://unsplash.com',
  weather_api: 'https://unsplash.com',
  lottery_json: 'https://unsplash.com',
  rss_feed: 'https://unsplash.com',
  currency_json: 'https://unsplash.com',
  health_tips: 'https://unsplash.com',
  daily_tips: 'https://unsplash.com',
};

interface ManifestItem {
  id: string;
  type: string;
  url: string;
  title?: string | null;
  duration: number;
  background_url?: string | null;
  clientId?: string;
  contract?: {
    startDate?: string | null;
    endDate?: string | null;
    startTime?: string | null;
    endTime?: string | null;
  };
  max_items?: number;
  display_format?: 'ticker_marquee' | 'slide';
  template?: 'weather_card_modern' | 'weather_card_minimal' | 'weather_card_compact';
  fields_to_show?: string[];
  league?: string;
  poster_url?: string;
}

interface ManifestResponse {
  playlistVersion: number;
  orientation: 'landscape' | 'portrait';
  remoteCommand: 'QUIT_PLAYER' | null;
  items: ManifestItem[];
}

export default function App() {
  useKeepAwake();

  const [screenCode, setScreenCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [items, setItems] = useState<ManifestItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);

  const [rssData, setRssData] = useState<any[]>([]);
  const [weatherData, setWeatherData] = useState<any>(null);
  const [lotteryData, setLotteryData] = useState<any>(null);
  const [soccerData, setSoccerData] = useState<any[]>([]);
  const [currencyData, setCurrencyData] = useState<any>(null);
  const [tipData, setTipData] = useState<{ title: string; text: string } | null>(null);

  const lastVersionRef = useRef<number>(-1);
  const itemsRef = useRef<ManifestItem[]>([]);
  const marqueeAnim = useRef(new Animated.Value(Dimensions.get('window').width)).current;

  useEffect(() => {
    NavigationBar.setVisibilityAsync('hidden').catch(() => {});
    AsyncStorage.getItem('@screen_code').then((saved) => {
      if (saved) setScreenCode(saved);
    });
  }, []);

  const fetchWithTimeout = async (url: string, timeoutMs = 10000) => {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
      });
      clearTimeout(id);
      return response;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  };

  useEffect(() => {
    if (!screenCode) return;

    const syncManifest = async () => {
      try {
        const res = await fetchWithTimeout(`${SUPABASE_MANIFEST_BASE}/${screenCode}/manifest.json`);
        if (res.status === 404) {
          setStatusMsg('Código de tela inválido');
          return;
        }
        if (!res.ok) return;

        const data: ManifestResponse = await res.json();
        setStatusMsg('');

        if (data.remoteCommand === 'QUIT_PLAYER') {
          BackHandler.exitApp();
          return;
        }

        if (data.orientation === 'portrait') {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
        } else {
          await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
        }

        if (data.playlistVersion > lastVersionRef.current) {
          lastVersionRef.current = data.playlistVersion;
          const validItems = Array.isArray(data.items) ? data.items : [];
          itemsRef.current = validItems;
          setItems(validItems);
          setCurrentIndex(0);
        }
      } catch {}
    };

    syncManifest();
    const interval = setInterval(syncManifest, 15000);
    return () => clearInterval(interval);
  }, [screenCode]);

  const isItemValidByContract = (item: ManifestItem): boolean => {
    if (!item.contract) return true;
    const now = new Date();
    const todayStr = now.toISOString().split('T');
    const timeStr = now.toTimeString().split(' ');

    const { startDate, endDate, startTime, endTime } = item.contract;
    if (startDate && todayStr < startDate) return false;
    if (endDate && todayStr > endDate) return false;
    if (startTime && timeStr < startTime) return false;
    if (endTime && timeStr > endTime) return false;
    return true;
  };

  const recordPlaybackMetric = async (item: ManifestItem) => {
    if (!item.clientId) return;
    try {
      const raw = await AsyncStorage.getItem('@playback_metrics');
      const metrics = raw ? JSON.parse(raw) : {};
      metrics[item.clientId] = (metrics[item.clientId] || 0) + (item.duration || 10);
      await AsyncStorage.setItem('@playback_metrics', JSON.stringify(metrics));
    } catch {}
  };

  const nextItem = () => {
    const list = itemsRef.current;
    if (!list || list.length === 0) return;

    const current = list[currentIndex];
    if (current) recordPlaybackMetric(current);

    for (let i = 1; i <= list.length; i++) {
      const candidateIdx = (currentIndex + i) % list.length;
      if (isItemValidByContract(list[candidateIdx])) {
        setCurrentIndex(candidateIdx);
        return;
      }
    }
    setCurrentIndex(-1);
  };

  useEffect(() => {
    if (items.length === 0 || currentIndex < 0) return;
    const item = items[currentIndex];
    if (!item) return;

    if (!isItemValidByContract(item)) {
      nextItem();
      return;
    }

    const loadDynamicContent = async () => {
      try {
        if (item.type === 'rss_feed') {
          const res = await fetchWithTimeout(item.url);
          const xml = await res.text();
          const parser = new XMLParser();
          const parsed = parser.parse(xml);
          const rawNews = parsed?.rss?.channel?.item || [];
          const list = (Array.isArray(rawNews) ? rawNews : [rawNews]).slice(0, item.max_items || 5);
          setRssData(list);
          await AsyncStorage.setItem(`@cache_${item.id}`, JSON.stringify(list));
        } else if (item.type === 'weather_api') {
          const res = await fetchWithTimeout(item.url);
          const json = await res.json();
          const normalized = json?.current_weather
            ? { temp: Math.round(json.current_weather.temperature), city: item.title || 'Previsão Local', description: 'Tempo Atual' }
            : (json?.results || json);
          setWeatherData(normalized);
          await AsyncStorage.setItem(`@cache_${item.id}`, JSON.stringify(normalized));
        } else if (item.type === 'lottery_json') {
          const res = await fetchWithTimeout(item.url);
          const json = await res.json();
          setLotteryData(json);
          await AsyncStorage.setItem(`@cache_${item.id}`, JSON.stringify(json));
        } else if (item.type === 'soccer_table') {
          const res = await fetchWithTimeout(item.url);
          const json = await res.json();
          setSoccerData(Array.isArray(json) ? json.slice(0, 8) : []);
          await AsyncStorage.setItem(`@cache_${item.id}`, JSON.stringify(json));
        } else if (item.type === 'currency_json') {
          const res = await fetchWithTimeout(item.url || 'https://awesomeapi.com.br');
          const json = await res.json();
          setCurrencyData(json);
          await AsyncStorage.setItem(`@cache_${item.id}`, JSON.stringify(json));
        } else if (item.type === 'health_tips' || item.type === 'daily_tips') {
          setTipData({
            title: item.title || (item.type === 'health_tips' ? 'SAÚDE & BEM-ESTAR' : 'CURIOSIDADE DO DIA'),
            text: 'Beber pelo menos 2 litros de água por dia melhora a concentração, regula a temperatura corporal e aumenta a disposição.',
          });
        }
      } catch {
        const cached = await AsyncStorage.getItem(`@cache_${item.id}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (item.type === 'rss_feed') setRssData(parsed);
          if (item.type === 'weather_api') setWeatherData(parsed);
          if (item.type === 'lottery_json') setLotteryData(parsed);
          if (item.type === 'soccer_table') setSoccerData(parsed);
          if (item.type === 'currency_json') setCurrencyData(parsed);
        }
      }
    };

    loadDynamicContent();

    const durationSec = Math.max(1, item.duration || 15);
    const timer = setTimeout(() => nextItem(), durationSec * 1000);
    return () => clearTimeout(timer);
  }, [currentIndex, items]);

  useEffect(() => {
    marqueeAnim.setValue(Dimensions.get('window').width);
    Animated.loop(
      Animated.timing(marqueeAnim, {
        toValue: -2500,
        duration: 20000,
        useNativeDriver: true,
      })
