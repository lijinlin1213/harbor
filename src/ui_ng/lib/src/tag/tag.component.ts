// Copyright (c) 2017 VMware, Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import {
  Component,
  OnInit,
  ViewChild,
  Input,
  Output,
  EventEmitter,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  ElementRef,
  OnDestroy
} from '@angular/core';

import { TagService } from '../service/tag.service';

import { ErrorHandler } from '../error-handler/error-handler';
import { ConfirmationTargets, ConfirmationState, ConfirmationButtons } from '../shared/shared.const';

import { ConfirmationDialogComponent } from '../confirmation-dialog/confirmation-dialog.component';
import { ConfirmationMessage } from '../confirmation-dialog/confirmation-message';
import { ConfirmationAcknowledgement } from '../confirmation-dialog/confirmation-state-message';

import { Tag, TagClickEvent } from '../service/interface';

import { TAG_TEMPLATE } from './tag.component.html';
import { TAG_STYLE } from './tag.component.css';

import { toPromise, CustomComparator, VULNERABILITY_SCAN_STATUS } from '../utils';

import { TranslateService } from '@ngx-translate/core';

import { State, Comparator } from 'clarity-angular';

import { ScanningResultService } from '../service/index';

import { Observable, Subscription } from 'rxjs/Rx';

const STATE_CHECK_INTERVAL: number = 2000;//2s

@Component({
  selector: 'hbr-tag',
  template: TAG_TEMPLATE,
  styles: [TAG_STYLE],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TagComponent implements OnInit, OnDestroy {

  @Input() projectId: number;
  @Input() repoName: string;
  @Input() isEmbedded: boolean;

  @Input() hasSignedIn: boolean;
  @Input() hasProjectAdminRole: boolean;
  @Input() registryUrl: string;
  @Input() withNotary: boolean;
  @Input() withClair: boolean;

  @Output() refreshRepo = new EventEmitter<boolean>();
  @Output() tagClickEvent = new EventEmitter<TagClickEvent>();

  tags: Tag[];


  showTagManifestOpened: boolean;
  manifestInfoTitle: string;
  digestId: string;
  staticBackdrop: boolean = true;
  closable: boolean = false;

  createdComparator: Comparator<Tag> = new CustomComparator<Tag>('created', 'date');

  loading: boolean = false;

  stateCheckTimer: Subscription;
  tagsInScanning: { [key: string]: any } = {};
  scanningTagCount: number = 0;

  copyFailed: boolean = false;

  @ViewChild('confirmationDialog')
  confirmationDialog: ConfirmationDialogComponent;

  @ViewChild('digestTarget') textInput: ElementRef;

  constructor(
    private errorHandler: ErrorHandler,
    private tagService: TagService,
    private translateService: TranslateService,
    private scanningService: ScanningResultService,
    private ref: ChangeDetectorRef) { }

  confirmDeletion(message: ConfirmationAcknowledgement) {
    if (message &&
      message.source === ConfirmationTargets.TAG
      && message.state === ConfirmationState.CONFIRMED) {
      let tag: Tag = message.data;
      if (tag) {
        if (tag.signature) {
          return;
        } else {
          toPromise<number>(this.tagService
            .deleteTag(this.repoName, tag.name))
            .then(
            response => {
              this.retrieve();
              this.translateService.get('REPOSITORY.DELETED_TAG_SUCCESS')
                .subscribe(res => this.errorHandler.info(res));
            }).catch(error => this.errorHandler.error(error));
        }
      }
    }
  }

  ngOnInit() {
    if (!this.projectId) {
      this.errorHandler.error('Project ID cannot be unset.');
      return;
    }
    if (!this.repoName) {
      this.errorHandler.error('Repo name cannot be unset.');
      return;
    }

    this.retrieve();

    this.stateCheckTimer = Observable.timer(STATE_CHECK_INTERVAL, STATE_CHECK_INTERVAL).subscribe(() => {
      if (this.scanningTagCount > 0) {
        this.updateScanningStates();
      }
    });
  }

  ngOnDestroy(): void {
    if (this.stateCheckTimer) {
      this.stateCheckTimer.unsubscribe();
    }
  }

  retrieve() {
    this.tags = [];
    this.loading = true;

    toPromise<Tag[]>(this.tagService
      .getTags(this.repoName))
      .then(items => {
        this.tags = items;
        this.loading = false;
        if (this.tags && this.tags.length === 0) {
          this.refreshRepo.emit(true);
        }
      })
      .catch(error => {
        this.errorHandler.error(error);
        this.loading = false;
      });
    let hnd = setInterval(() => this.ref.markForCheck(), 100);
    setTimeout(() => clearInterval(hnd), 5000);
  }

  deleteTag(tag: Tag) {
    if (tag) {
      let titleKey: string, summaryKey: string, content: string, buttons: ConfirmationButtons;
      if (tag.signature) {
        titleKey = 'REPOSITORY.DELETION_TITLE_TAG_DENIED';
        summaryKey = 'REPOSITORY.DELETION_SUMMARY_TAG_DENIED';
        buttons = ConfirmationButtons.CLOSE;
        content = 'notary -s https://' + this.registryUrl + ':4443 -d ~/.docker/trust remove -p ' + this.registryUrl + '/' + this.repoName + ' ' + tag.name;
      } else {
        titleKey = 'REPOSITORY.DELETION_TITLE_TAG';
        summaryKey = 'REPOSITORY.DELETION_SUMMARY_TAG';
        buttons = ConfirmationButtons.DELETE_CANCEL;
        content = tag.name;
      }
      let message = new ConfirmationMessage(
        titleKey,
        summaryKey,
        content,
        tag,
        ConfirmationTargets.TAG,
        buttons);
      this.confirmationDialog.open(message);
    }
  }

  showDigestId(tag: Tag) {
    if (tag) {
      this.manifestInfoTitle = 'REPOSITORY.COPY_DIGEST_ID';
      this.digestId = tag.digest;
      this.showTagManifestOpened = true;
      this.copyFailed = false;
    }
  }
  
  onTagClick(tag: Tag): void {
    if (tag) {
      let evt: TagClickEvent = {
        project_id: this.projectId,
        repository_name: this.repoName,
        tag_name: tag.name
      };
      this.tagClickEvent.emit(evt);
    }
  }

  scanTag(tagId: string): void {
    //Double check
    if (this.tagsInScanning[tagId]) {
      return;
    }
    toPromise<any>(this.scanningService.startVulnerabilityScanning(this.repoName, tagId))
      .then(() => {
        //Add to scanning map
        this.tagsInScanning[tagId] = tagId;
        //Counting
        this.scanningTagCount += 1;
      })
      .catch(error => this.errorHandler.error(error));
  }

  updateScanningStates(): void {
    toPromise<Tag[]>(this.tagService
      .getTags(this.repoName))
      .then(items => {
        console.debug("updateScanningStates called!");
        //Reset the scanning states
        this.tagsInScanning = {};
        this.scanningTagCount = 0;

        items.forEach(item => {
          if (item.scan_overview) {
            if (item.scan_overview.scan_status === VULNERABILITY_SCAN_STATUS.pending ||
              item.scan_overview.scan_status === VULNERABILITY_SCAN_STATUS.running) {
              this.tagsInScanning[item.name] = item.name;
              this.scanningTagCount += 1;
            }
          }
        });

        this.tags = items;
      })
      .catch(error => {
        this.errorHandler.error(error);
      });
    let hnd = setInterval(() => this.ref.markForCheck(), 100);
    setTimeout(() => clearInterval(hnd), 1000);
  }

  onSuccess($event: any): void {
    this.copyFailed = false;
    //Directly close dialog
    this.showTagManifestOpened = false;
  }

  onError($event: any): void {
    //Show error
    this.copyFailed = true;
    //Select all text
    if(this.textInput){
      this.textInput.nativeElement.select();
    }
  }
}
