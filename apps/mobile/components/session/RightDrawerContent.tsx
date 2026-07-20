/**
 * RightDrawerContent — the project's right-side navigation drawer.
 *
 * Mirrors the web project sidebar: BUILD / CONNECT / AUTOMATE sections up top
 * and a pinned utility group (Changes · Files · Sandbox · Dev · Members ·
 * Settings) at the bottom. Tapping an item opens it as a page tab and closes
 * the drawer.
 *
 * NOTE: these route to NEW page ids that currently render a PlaceholderPage.
 * The legacy page components (Files/Terminal/Secrets/…) are intentionally kept
 * in the codebase but no longer wired here — we'll point these entries at real
 * pages incrementally.
 */

import { haptics } from '@/lib/haptics';
import { useChangeRequests } from '@/lib/projects/hooks';
import { hasMobileImageTarget } from '@/lib/studio/mobile-image-studio';
import { useThemeColors } from '@/lib/theme-colors';
import { useTabStore } from '@/stores/tab-store';
import { Ionicons } from '@expo/vector-icons';
import { useIntelligenceCapabilityDiscovery } from '@kortix/sdk/react';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import type React from 'react';
import { Text as RNText, ScrollView, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface MenuItem {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  pageId: string;
  route?: string;
}

interface MenuSection {
  title: string;
  items: MenuItem[];
}

interface RightDrawerContentProps {
  onClose: () => void;
  projectId?: string;
}

// Top sections — scroll if they overflow.
const topSections: MenuSection[] = [
  {
    title: 'BUILD',
    items: [
      { icon: 'hardware-chip-outline', label: 'Agents', pageId: 'page:agents' },
      { icon: 'sparkles-outline', label: 'Skills', pageId: 'page:skills' },
      { icon: 'code-slash-outline', label: 'Commands', pageId: 'page:commands' },
    ],
  },
  {
    title: 'CONNECT',
    items: [
      { icon: 'extension-puzzle-outline', label: 'Connectors', pageId: 'page:connectors' },
      { icon: 'key-outline', label: 'Secrets', pageId: 'page:secrets-nav' },
      { icon: 'chatbox-outline', label: 'Channels', pageId: 'page:channels-nav' },
    ],
  },
  {
    title: 'AUTOMATE',
    items: [
      { icon: 'time-outline', label: 'Schedules', pageId: 'page:schedules' },
      { icon: 'git-network-outline', label: 'Webhooks', pageId: 'page:webhooks' },
    ],
  },
];

// Pinned utility group at the bottom of the drawer.
const bottomItems: MenuItem[] = [
  { icon: 'git-pull-request-outline', label: 'Changes', pageId: 'page:changes' },
  { icon: 'folder-outline', label: 'Files', pageId: 'page:files-nav' },
  { icon: 'terminal-outline', label: 'Terminal', pageId: 'page:terminal' },
  { icon: 'compass-outline', label: 'Browser', pageId: 'page:browser' },
  { icon: 'cube-outline', label: 'Sandbox', pageId: 'page:sandbox' },
  { icon: 'git-branch-outline', label: 'Dev', pageId: 'page:dev' },
  { icon: 'people-outline', label: 'Members', pageId: 'page:members' },
  { icon: 'settings-outline', label: 'Settings', pageId: 'page:settings' },
];

export function RightDrawerContent({ onClose, projectId }: RightDrawerContentProps) {
  const router = useRouter();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const studioDiscovery = useIntelligenceCapabilityDiscovery(projectId, {
    enabled: !!projectId,
    pollingEnabled: false,
  });
  const studioAvailable = hasMobileImageTarget(studioDiscovery.data?.execution_targets ?? []);

  // Open change-request count → a "review" nudge badge on the Changes item.
  const openCrCount = useChangeRequests(projectId ?? null, 'open').data?.change_requests.length ?? 0;

  // Colors aligned with the left drawer (home.tsx renderDrawerContent + global.css tokens).
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#999999' : '#6e6e6e';
  const sectionColor = isDark ? '#666' : '#999';
  const bgColor = isDark ? '#090909' : '#F5F5F5'; // matches --chrome-background
  const dividerColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const sections = studioAvailable && projectId
    ? [
        {
          title: 'CREATE',
          items: [
            {
              icon: 'image-outline',
              label: 'Image Studio',
              pageId: 'route:image-studio',
              route: `/projects/${projectId}/studio`,
            },
          ],
        },
        ...topSections,
      ]
    : topSections;

  const handleItemPress = (item: MenuItem) => {
    haptics.tap();
    if (item.route) router.push(item.route);
    else useTabStore.getState().navigateToPage(item.pageId);
    onClose();
  };

  const renderItem = (item: MenuItem) => (
    <TouchableOpacity
      key={item.pageId}
      onPress={() => handleItemPress(item)}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
        gap: 12,
      }}
    >
      <Ionicons name={item.icon} size={18} color={mutedColor} />
      <RNText style={{ fontSize: 15, fontFamily: 'Roobert', color: fgColor }}>
        {item.label}
      </RNText>
      {item.pageId === 'page:changes' && openCrCount > 0 && (
        <>
          <View style={{ flex: 1 }} />
          <View style={{ minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 999, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center' }}>
            <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{openCrCount}</RNText>
          </View>
        </>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1,  paddingTop: insets.top }} className='bg-chrome-background'>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
        {sections.map((section) => (
          <View key={section.title} style={{ marginBottom: 8 }}>
            <RNText
              style={{
                fontSize: 11,
                fontFamily: 'Roobert-Medium',
                color: sectionColor,
                letterSpacing: 1,
                paddingHorizontal: 16,
                paddingTop: 16,
                paddingBottom: 8,
              }}
            >
              {section.title}
            </RNText>
            {section.items.map(renderItem)}
          </View>
        ))}
      </ScrollView>

      {/* Pinned utility group */}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: dividerColor,
          paddingTop: 8,
          paddingBottom: insets.bottom + 8,
        }}
      >
        {bottomItems.map(renderItem)}
      </View>
    </View>
  );
}
