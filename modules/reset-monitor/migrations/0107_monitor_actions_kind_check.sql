ALTER TABLE monitor_event_actions ADD CONSTRAINT monitor_event_actions_action_check CHECK (action IN ('announce','confirm','amend','progress','cancel','close','expire','reopen','restore')) NOT VALID;
