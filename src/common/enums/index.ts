export enum Role {
  SUPERADMIN = 'superadmin',
  ADMIN = 'admin',
  USER = 'user',
}

export enum OtpPurpose {
  RESET_PASSWORD = 'reset_password',
  DELETE_FILE = 'delete_file',
  CHANGE_EMAIL = 'change_email',
  HIGH_RISK_ACTION = 'high_risk_action',
  TWO_FACTOR_LOGIN = 'two_factor_login',
  ACCOUNT_DELETION = 'account_deletion',
}

export enum ShareType {
  LINK = 'link',
  EMAIL = 'email',
  PRIVATE = 'private',
}

export enum SharePermission {
  VIEW = 'view',
  DOWNLOAD = 'download',
}

export enum ResourceType {
  FILE = 'file',
  FOLDER = 'folder',
  TRANSFER = 'transfer',
}

export enum ShareAccessAction {
  VIEW = 'view',
  DOWNLOAD = 'download',
}
