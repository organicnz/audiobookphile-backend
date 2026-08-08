import { SupabaseClient } from "npm:@supabase/supabase-js@2.44.0";
import { Database } from "../../../../src/types/supabase.ts";

export type AuthUser = {
  id: string;
  username: string;
  email: string | null;
  type: string;
  permissions: {
    download: boolean;
    update: boolean;
    delete: boolean;
    upload: boolean;
    accessAllLibraries: boolean;
    accessAllTags: boolean;
    accessExplicitContent: boolean;
  };
  librariesAccessible: string[];
  itemTagsAccessible: string[];
  created_at?: string;
  last_sign_in_at?: string;
};

export type Variables = {
  supabaseUrl: string;
  serviceRoleKey: string;
  supabase: SupabaseClient<Database>;
  user: AuthUser | null;
  userId: string;
  userEmail: string | null;
  sessionId: string;
  token: string;
  requiresServiceRole: boolean;
  userDefaultLibraryId: string | null;
  requireUser: () => Promise<AuthUser>;
  requestId: string;
};

export type ChapterAIInsights = {
  summary: string;
  keyTakeaways: string[];
  mood?: string;
};

export type BookAIInsights = {
  bookId: string;
  title: string;
  author: string | null;
  summary: string;
  keyTakeaways: string[];
  mood: string;
  themes: string[];
  isCached: boolean;
};
