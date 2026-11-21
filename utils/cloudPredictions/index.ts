export {
  agree,
  decline,
  declineIfDataCollectionRevoked,
  getCloudPredictionsStatus,
  getConsent,
  getReporterId,
  isOn,
  onCloudPredictionsChange,
  optionsSectionOf,
} from '@/utils/cloudPredictions/consent';
export { onDataCollectionChange } from '@/utils/cloudPredictions/dataCollection';
export { openConsentTabIfDue, shouldOpenConsentTab } from '@/utils/cloudPredictions/consentTab';
